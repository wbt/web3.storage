import { PostgrestClient } from '@supabase/postgrest-js'

import {
  normalizeUpload,
  normalizeContent,
  normalizePins,
  normalizeDeals,
  normalizePsaPinRequest,
  parseTextToNumber
} from './utils.js'
import { ConstraintError, DBError } from './errors.js'

export { EMAIL_TYPE } from './constants.js'
export { parseTextToNumber } from './utils.js'

const uploadQuery = `
        _id:id::text,
        type,
        name,
        sourceCid:source_cid,
        created:inserted_at,
        updated:updated_at,
        content(cid, dagSize:dag_size, pins:pin(status, updated:updated_at, location:pin_location(_id:id, peerId:peer_id, peerName:peer_name, ipfsPeerId:ipfs_peer_id, region)))
      `

const getUserQuery = options => `
   _id:id::text,
  issuer,
  name,
  email,
  github,
  publicAddress:public_address,
  created:inserted_at,
  updated:updated_at
  ${options?.includeTags ? ',tags:user_tag_user_id_fkey(user_id,id,tag,value,deleted_at)' : ''}
  ${options?.includeTagProposals ? ',tagProposals:user_tag_proposal_user_id_fkey(user_id,id,admin_decision_type,tag,proposed_tag_value,deleted_at)' : ''}
`

const psaPinRequestTableName = 'psa_pin_request'
const pinRequestSelect = `
  _id:id::text,
  sourceCid:source_cid,
  contentCid:content_cid,
  authKey:auth_key_id::text,
  name,
  origins,
  meta,
  deleted:deleted_at,
  created:inserted_at,
  updated:updated_at,
  content(cid, dagSize:dag_size, pins:pin(status, updated:updated_at, location:pin_location(_id:id::text, peerId:peer_id, peerName:peer_name, ipfsPeerId:ipfs_peer_id, region)))`

const listPinsQuery = `
  _id:id::text,
  sourceCid:source_cid,
  contentCid:content_cid,
  authKey:auth_key_id,
  name,
  meta,
  deleted:deleted_at,
  created:inserted_at,
  updated:updated_at,
  content!inner(
    cid,
    dagSize:dag_size,
    pins:pin!inner(
      status,
      updated:updated_at,
      location:pin_location(
        _id:id,
        peerId:peer_id,
        peerName:peer_name,
        ipfsPeerId:ipfs_peer_id,
        region
      )
    )
  )`

/**  Mapping of Upload table sortable columns to ListUploads sortBy arguments. */
const sortableColumnToUploadArgMap = {
  inserted_at: 'Date',
  name: 'Name'
}

/**
 * @typedef {import('./postgres/pg-rest-api-types').definitions} definitions
 * @typedef {import('@supabase/postgrest-js').PostgrestError} PostgrestError
 */

export class DBClient {
  constructor ({ endpoint, token }) {
    this._client = new PostgrestClient(endpoint, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: '*/*'
      }
    })
  }

  /**
   * Upsert user.
   *
   * @param {import('./db-client-types').UpsertUserInput} user
   * @return {Promise<import('./db-client-types').UpsertUserOutput>}
   */
  async upsertUser (user) {
    /** @type {{ data: definitions['user'], error: PostgrestError }} */
    const { data, error } = await this._client
      .from('user')
      .upsert(
        {
          id: user.id,
          name: user.name,
          picture: user.picture,
          email: user.email,
          issuer: user.issuer,
          github: user.github,
          public_address: user.publicAddress
        },
        {
          onConflict: 'issuer'
        }
      )
      .single()

    if (error) {
      throw new DBError(error)
    }

    return {
      issuer: data.issuer
    }
  }

  /**
   * Get user by its issuer.
   *
   * @param {string} issuer
   * @param {import('./db-client-types').GetUserOptions?} options
   * @return {Promise<import('./db-client-types').UserOutput | undefined>}
   */
  async getUser (issuer, options) {
    /** @type {{ data: import('./db-client-types').UserOutput[], error: PostgrestError }} */
    const { data, error } = await this._client
      .from('user')
      .select(getUserQuery(options))
      .eq('issuer', issuer)

    if (error) {
      throw new DBError(error)
    }

    return data.length ? data[0] : undefined
  }

  /**
   * Get user by email.
   * @param {string} email
   * @return {Promise<import('./db-client-types').UserOutput | undefined>}
   */
  async getUserByEmail (email) {
    /** @type {{ data: import('./db-client-types').UserOutput[], error: PostgrestError }} */
    const { data, error } = await this._client
      .from('user')
      .select(getUserQuery())
      .eq('email', email)

    if (error) {
      throw new DBError(error)
    }

    return data.length ? data[0] : undefined
  }

  /**
   * Create a user tag
   * @param {string} userId
   * @param {import('./db-client-types').UserTagInput} tag
   * @returns {Promise<boolean>}
   */
  async createUserTag (userId, tag) {
    if (!tag?.tag) {
      throw new Error('createUserTag requires a tag')
    }
    const { data: deleteData, status: deleteStatus } = await this._client
      .from('user_tag')
      .update({
        deleted_at: new Date().toISOString()
      })
      .match({ user_id: userId, tag: tag.tag })
      .is('deleted_at', null)
      .single()

    // the previous tag was marked as deleted
    // or there was no previous tag of this type
    // ^ if either of these 2 scenarios are true then we add a new tag
    if (deleteStatus === 200 || (deleteStatus === 406 && !deleteData)) {
      const { status: insertStatus } = await this._client
        .from('user_tag')
        .insert({
          user_id: userId,
          tag: tag.tag,
          value: tag.value,
          reason: tag.reason || '',
          inserted_at: new Date().toISOString(),
          deleted_at: null
        })
        .single()

      if (insertStatus === 201) {
        return true
      }
    }
    return false
  }

  /**
   * Creates a user tag change request
   *
   * @param {string} userId
   * @param {string} tagName
   * @param {string} requestedTagValue
   * @param {JSON} userProposalForm
   * @returns
   */
  async createUserRequest (
    userId,
    tagName,
    requestedTagValue,
    userProposalForm
  ) {
    const { data: deleteData, status: deleteStatus } = await this._client
      .from('user_tag_proposal')
      .update({
        deleted_at: new Date().toISOString()
      })
      .match({ user_id: userId, tag: tagName })
      .is('deleted_at', null)

    if (
      deleteStatus === 200 ||
      ((deleteStatus === 406 || deleteStatus === 404) && !deleteData)
    ) {
      const { error: insertError, status: insertStatus } = await this._client
        .from('user_tag_proposal')
        .insert({
          user_id: userId,
          tag: tagName,
          proposed_tag_value: requestedTagValue,
          inserted_at: new Date().toISOString(),
          user_proposal_form: userProposalForm
        })
        .single()

      if (insertError) {
        throw new DBError(insertError)
      }

      if (insertStatus === 201) {
        return true
      }
    }

    return false
  }

  /**
   * Returns the value stored for an active (non-deleted) user tag.
   *
   * @param {number} userId
   * @param {string} tag
   * @returns {Promise<string | undefined>}
   */
  async getUserTagValue (userId, tag) {
    const { data, error } = await this._client
      .from('user_tag')
      .select('value')
      .eq('user_id', userId)
      .eq('tag', tag)
      .filter('deleted_at', 'is', null)

    if (error) {
      throw new DBError(error)
    }

    // Expects unique entries.
    if (data.length > 1) {
      throw new ConstraintError({
        message: `More than one row found for user tag ${tag}`
      })
    }

    return data.length ? data[0].value : undefined
  }

  /**
   * Returns all the active (non-deleted) user tags for a user id.
   *
   * @param {string} userId
   * @returns {Promise<import('./db-client-types').UserTagInfo[]>}
   */
  async getUserTags (userId) {
    const { data, error } = await this._client
      .from('user_tag')
      .select(
        `
        tag,
        value
      `
      )
      .eq('user_id', userId)
      .filter('deleted_at', 'is', null)

    if (error) {
      throw new DBError(error)
    }

    // Ensure active user tags are unique.
    const tags = new Set()
    data.forEach((item) => {
      if (tags.has(item.tag)) {
        throw new ConstraintError({
          message: `More than one row found for user tag ${item.tag}`
        })
      }
      tags.add(item.tag)
    })

    return data
  }

  /**
   * Get used storage in bytes, both uploaded and pinned.
   *
   * @param {number} userId
   * @returns {Promise<import('./db-client-types').StorageUsedOutput>}
   */
  async getStorageUsed (userId) {
    /** @type {{ data: { uploaded: string, psa_pinned: string, total: string }, error: PostgrestError }} */
    const { data, error } = await this._client
      .rpc('user_used_storage', { query_user_id: userId })
      .single()

    if (error) {
      throw new DBError(error)
    }

    return {
      uploaded: parseTextToNumber(data.uploaded),
      psaPinned: parseTextToNumber(data.psa_pinned),
      total: parseTextToNumber(data.total)
    }
  }

  /**
   * Get all users with storage used in a percentage range of their allocated quota
   * @param {import('./db-client-types').UserStorageUsedInput} percentRange
   * @returns {Promise<Array<import('./db-client-types').UserStorageUsedOutput>>}
   */
  async getUsersByStorageUsed (percentRange) {
    const { fromPercent, toPercent = null } = percentRange

    const { data, error } = await this._client.rpc('users_by_storage_used', {
      from_percent: fromPercent,
      to_percent: toPercent
    })

    if (error) {
      throw new DBError(error)
    }

    return data.map((user) => {
      return {
        id: user.id,
        name: user.name,
        email: user.email,
        storageQuota: user.storage_quota,
        storageUsed: user.storage_used,
        percentStorageUsed: Math.floor(
          (user.storage_used / user.storage_quota) * 100
        )
      }
    })
  }

  /**
   * Check the email history for a specified email type to see if it has
   * been sent within a specified number of days. If not, it is resent.
   * @param {import('./db-client-types').EmailSentInput} email
   * @returns {Promise<boolean>}
   */
  async emailHasBeenSent (email) {
    const {
      userId,
      emailType,
      secondsSinceLastSent = 60 * 60 * 24 * 7
    } = email

    const lastSentAtDate = new Date()
    lastSentAtDate.setSeconds(
      lastSentAtDate.getSeconds() - secondsSinceLastSent
    )
    const lastSentAt = lastSentAtDate.toISOString()

    const { count, error } = await this._client
      .from('email_history')
      .select('id', { count: 'exact' })
      .eq('user_id', userId)
      .eq('email_type', emailType)
      .gt('sent_at', lastSentAt)

    if (error) {
      throw new DBError(error)
    }

    return count > 0
  }

  /**
   * Log that an email has been sent
   * @param {import('./db-client-types').LogEmailSentInput} email
   * @returns {Promise<number>}
   */
  async logEmailSent (email) {
    const { userId, emailType, messageId } = email

    const { data, error } = await this._client.from('email_history').upsert({
      user_id: userId,
      email_type: emailType,
      message_id: messageId
    })

    if (error) {
      throw new DBError(error)
    }

    return data[0].id
  }

  /**
   * Create upload with content and pins.
   *
   * @param {import('./db-client-types').CreateUploadInput} data
   * @returns {Promise<import('./db-client-types').CreateUploadOutput>}
   */
  async createUpload (data) {
    const now = new Date().toISOString()

    /** @type {{ data: string, error: PostgrestError }} */
    const { data: uploadResponse, error } = await this._client
      .rpc('create_upload', {
        data: {
          user_id: data.user,
          auth_key_id: data.authKey,
          content_cid: data.contentCid,
          source_cid: data.sourceCid,
          type: data.type,
          name: data.name,
          dag_size: data.dagSize,
          inserted_at: data.created || now,
          updated_at: data.updated || now,
          pins: data.pins.map((pin) => ({
            status: pin.status,
            location: {
              peer_id: pin.location.peerId,
              peer_name: pin.location.peerName,
              ipfs_peer_id: pin.location.ipfsPeerId,
              region: pin.location.region
            }
          })),
          backup_urls: data.backupUrls
        }
      })
      .single()

    if (error) {
      throw new DBError(error)
    }

    return {
      _id: uploadResponse,
      cid: data.sourceCid
    }
  }

  /**
   * Get upload with user, auth_keys, content and pins.
   *
   * @param {string} cid
   * @param {number} userId
   * @returns {Promise<import('./db-client-types').UploadItemOutput>}
   */
  async getUpload (cid, userId) {
    /** @type {{ data: import('./db-client-types').UploadItem, error: PostgrestError }} */
    const { data: upload, error } = await this._client
      .from('upload')
      .select(uploadQuery)
      .eq('source_cid', cid)
      .eq('user_id', userId)
      .is('deleted_at', null)
      .single()

    if (error) {
      throw new DBError(error)
    }

    const deals = await this.getDeals(cid)

    return {
      ...normalizeUpload(upload),
      deals
    }
  }

  /**
   * List uploads of a given user.
   *
   * @param {number} userId
   * @param {import('./db-client-types').ListUploadsOptions} [opts]
   * @returns {import('./db-client-types').ListUploadReturn}
   */
  async listUploads (userId, opts = {}) {
    const rangeFrom = opts.offset || 0
    const rangeTo = rangeFrom + (opts.size || 25)
    const isAscendingSortOrder = opts.sortOrder === 'Asc'
    const defaultSortByColumn = Object.keys(sortableColumnToUploadArgMap)[0]
    const sortByColumn = Object.keys(sortableColumnToUploadArgMap).find(key => sortableColumnToUploadArgMap[key] === opts.sortBy)
    const sortBy = sortByColumn || defaultSortByColumn

    let query = this._client
      .from('upload')
      .select(uploadQuery, { count: 'exact' })
      .eq('user_id', userId)
      .is('deleted_at', null)
      .order(
        sortBy,
        { ascending: isAscendingSortOrder }
      )

    // Apply filtering
    if (opts.before) {
      query = query.lt('inserted_at', opts.before)
    }

    if (opts.after) {
      query = query.gte('inserted_at', opts.after)
    }

    // Apply pagination or limiting.
    query = query.range(rangeFrom, rangeTo - 1)

    /** @type {{ data: Array<import('./db-client-types').UploadItem>, error: Error, count: Number }} */
    const { data: uploads, error, count } = await query

    if (error) {
      throw new DBError(error)
    }

    // Get deals
    const cids = uploads?.map((u) => u.content.cid)
    const deals = await this.getDealsForCids(cids)

    return {
      count,
      uploads: uploads?.map((u) => ({
        ...normalizeUpload(u),
        deals: deals[u.content.cid] || []
      }))
    }
  }

  /**
   * Rename an upload.
   *
   * @param {number} userId
   * @param {string} cid
   * @param {string} name
   */
  async renameUpload (userId, cid, name) {
    /** @type {{ data: import('./db-client-types').UploadItem, error: PostgrestError }} */
    const { data, error } = await this._client
      .from('upload')
      .update({ name })
      .match({
        user_id: userId,
        source_cid: cid
      })
      .is('deleted_at', null)
      .single()

    if (error) {
      throw new DBError(error)
    }

    return {
      name: data.name
    }
  }

  /**
   * Delete a user upload.
   *
   * @param {number} userId
   * @param {string} cid
   */
  async deleteUpload (userId, cid) {
    const now = new Date().toISOString()
    /** @type {{ data: import('./db-client-types').UploadItem, error: PostgrestError, status: number }} */
    const { data, error, status } = await this._client
      .from('upload')
      .update({
        deleted_at: now,
        updated_at: now
      })
      .match({
        source_cid: cid,
        user_id: userId
      })
      .is('deleted_at', null)
      .single()

    if (status === 406 || !data) {
      return
    }

    if (error) {
      throw new DBError(error)
    }

    return {
      _id: data.id
    }
  }

  /**
   * Get content status of a given cid.
   *
   * @param {string} cid
   * @returns {Promise<import('./db-client-types').ContentItemOutput>}
   */
  async getStatus (cid) {
    /** @type {{ data: Array<import('./db-client-types').ContentItem>, error: PostgrestError }} */
    const { data, error } = await this._client
      .from('content')
      .select(
        `
        cid,
        dagSize:dag_size,
        created:inserted_at,
        pins:pin(status, updated:updated_at, location:pin_location(peerId:peer_id, peerName:peer_name, ipfsPeerId:ipfs_peer_id, region))
      `
      )
      .match({ cid })

    if (error) {
      throw new DBError(error)
    }

    if (!data || !data.length) {
      return undefined
    }

    const deals = await this.getDeals(cid)
    return {
      ...normalizeContent(data[0]),
      deals
    }
  }

  /**
   * Get backups for a given upload.
   *
   * @param {number} uploadId
   * @return {Promise<Array<import('./db-client-types').BackupOutput>>}
   */
  async getBackups (uploadId) {
    /** @type {{ data: {backupUrls: definitions['upload']['backup_urls']}, error: PostgrestError }} */
    const {
      data: { backupUrls },
      error
    } = await this._client
      .from('upload')
      .select('backupUrls:backup_urls')
      .eq('id', uploadId)
      .single()

    if (error) {
      throw new DBError(error)
    }

    const uniqueUrls = new Set(backupUrls)

    return Array.from(uniqueUrls)
  }

  /**
   * Upsert pin of a given cid.
   *
   * @param {string} cid
   * @param {import('./db-client-types').PinUpsertInput} pin
   * @return {Promise<string>}
   */
  async upsertPin (cid, pin) {
    /** @type {{ data: string, error: PostgrestError }} */
    const { data: pinId, error } = await this._client
      .rpc('upsert_pin', {
        data: {
          content_cid: cid,
          pin: {
            status: pin.status,
            location: {
              peer_id: pin.location.peerId,
              peer_name: pin.location.peerName,
              ipfs_peer_id: pin.location.ipfsPeerId,
              region: pin.location.region
            }
          }
        }
      })
      .single()

    if (error) {
      throw new DBError(error)
    }

    return pinId
  }

  /**
   * Upsert pins.
   *
   * NOTE: currently only used to batch update the pin status.
   *
   * @param {Array<import('./db-client-types').PinsUpsertInput>} pins
   */
  async upsertPins (pins) {
    const { data: pinIds, error } = await this._client
      .rpc('upsert_pins', {
        data: {
          pins: pins.map((pin) => ({
            data: {
              content_cid: pin.contentCid,
              pin: {
                status: pin.status,
                location: {
                  peer_id: pin.location.peerId,
                  peer_name: pin.location.peerName,
                  ipfs_peer_id: pin.location.ipfsPeerId,
                  region: pin.location.region
                }
              }
            }
          }))
        }
      })
      .single()

    if (error) {
      throw new DBError(error)
    }

    return pinIds
  }

  /**
   * Get Pins for a cid
   *
   * @param {string} cid
   * @return {Promise<Array<import('./db-client-types').PinItemOutput>>}
   */
  async getPins (cid) {
    /** @type {{ data: Array<import('./db-client-types').PinItem>, error: PostgrestError }} */
    const { data: pins, error } = await this._client
      .from('pin')
      .select(
        `
        _id:id::text,
        status,
        created:inserted_at,
        updated:updated_at,
        location:pin_location(id::text, peerId:peer_id, peerName:peer_name, ipfsPeerId:ipfs_peer_id, region)
      `
      )
      .match({ content_cid: cid })

    if (error) {
      throw new DBError(error)
    }

    return normalizePins(pins)
  }

  /**
   * Get All Pin requests.
   *
   * @param {Object} [options]
   * @param {number} [options.size = 600]
   * @return {Promise<Array<import('./db-client-types').PinRequestItemOutput>>}
   */
  async getPinRequests ({ size = 600 } = {}) {
    /** @type {{ data: Array<import('./db-client-types').PinRequestItemOutput>, error: PostgrestError }} */
    const { data: pinReqs, error } = await this._client
      .from('pin_request')
      .select(
        `
        _id:id::text,
        cid:content_cid,
        created:inserted_at
      `
      )
      .limit(size)

    if (error) {
      throw new DBError(error)
    }

    return pinReqs
  }

  /**
   * Delete pin requests with provided ids.
   *
   * @param {Array<number>} ids
   * @return {Promise<void>}
   */
  async deletePinRequests (ids) {
    /** @type {{ error: PostgrestError }} */
    const { error } = await this._client
      .from('pin_request')
      .delete()
      .in('id', ids)

    if (error) {
      throw new DBError(error)
    }
  }

  /**
   * Create pin sync requests.
   *
   * @param {Array<number>} pinSyncRequests
   */
  async createPinSyncRequests (pinSyncRequests) {
    /** @type {{ error: PostgrestError }} */
    const { error } = await this._client.from('pin_sync_request').upsert(
      pinSyncRequests.map((psr) => ({
        pin_id: psr,
        inserted_at: new Date().toISOString()
      })),
      {
        onConflict: 'pin_id'
      }
    )

    if (error) {
      throw new DBError(error)
    }
  }

  /**
   * Get All Pin Sync requests.
   *
   * @param {Object} [options]
   * @param {string} [options.to]
   * @param {string} [options.after]
   * @param {number} [options.size]
   * @return {Promise<import('./db-client-types').PinSyncRequestOutput>}
   */
  async getPinSyncRequests ({ to, after, size }) {
    let query = this._client
      .from('pin_sync_request')
      .select(
        `
        _id:id::text,
        pin:pin(_id:id::text, status, contentCid:content_cid, created:inserted_at, location:pin_location(_id:id::text, peerId:peer_id, peerName:peer_name, ipfsPeerId:ipfs_peer_id, region))
      `
      )
      .order('inserted_at', { ascending: true })
      .limit(size)

    if (to) {
      query = query.lt('inserted_at', to)
    }
    if (after) {
      query = query.gte('inserted_at', after)
    }

    /** @type {{ data: Array<import('./db-client-types').PinSyncRequestItem>, error: PostgrestError }} */
    const { data: pinSyncReqs, error } = await query
    if (error) {
      throw new DBError(error)
    }

    return {
      data: pinSyncReqs,
      after:
        !!size && pinSyncReqs.length === size && pinSyncReqs[0].pin.created // return after if more
    }
  }

  /**
   * Delete pin sync requests with provided ids.
   *
   * @param {Array<number>} ids
   * @return {Promise<void>}
   */
  async deletePinSyncRequests (ids) {
    /** @type {{ error: PostgrestError }} */
    const { error } = await this._client
      .from('pin_sync_request')
      .delete()
      .in('id', ids)

    if (error) {
      throw new DBError(error)
    }
  }

  /**
   * Get deals for a cid
   *
   * @param {string} cid
   * @return {Promise<import('./db-client-types').Deal[]>}
   */
  async getDeals (cid) {
    const deals = await this.getDealsForCids([cid])
    return deals[cid] ? deals[cid] : []
  }

  /**
   * Get deals for multiple cids. This function is error tolerant as it uses
   * the dagcargo FDW. It will return an empty object if any error is
   * encountered fetching the data.
   *
   * @param {string[]} cids
   * @return {Promise<Record<string, import('./db-client-types').Deal[]>>}
   */
  async getDealsForCids (cids = []) {
    /** @type {{ data: Array<import('./db-client-types').Deal>, error: PostgrestError }} */
    const { data, error } = await this._client.rpc(
      'find_deals_by_content_cids',
      {
        cids
      }
    )

    if (error) {
      return {}
    }

    const result = {}
    for (const d of normalizeDeals(data)) {
      const cid = d.contentCid
      delete d.contentCid
      if (!Array.isArray(result[cid])) {
        result[cid] = [d]
      } else {
        result[cid].push(d)
      }
    }

    return result
  }

  /**
   * Create a new auth key.
   *
   * @param {import('./db-client-types').CreateAuthKeyInput} key
   * @return {Promise<import('./db-client-types').CreateAuthKeyOutput>}
   */
  async createKey ({ name, secret, user }) {
    const now = new Date().toISOString()

    /** @type {{ data: string, error: PostgrestError }} */
    const { data, error } = await this._client
      .rpc('create_key', {
        data: {
          name,
          secret,
          user_id: user,
          inserted_at: now,
          updated_at: now
        }
      })
      .single()

    if (error) {
      throw new DBError(error)
    }

    return {
      _id: data
    }
  }

  /**
   * Get key with issuer and secret.
   *
   * @param {string} issuer
   * @param {string} secret
   * @return {Promise<import('./db-client-types').AuthKey | undefined>}
   */
  async getKey (issuer, secret) {
    /** @type {{ data, error: PostgrestError }} */
    const { data, error } = await this._client
      .from('user')
      .select(
        `
        _id:id::text,
        issuer,
        keys:auth_key_user_id_fkey(
          _id:id::text,
          name,
          secret,
          deleted_at
        )
      `
      )
      .match({
        issuer
      })
      .eq('keys.secret', secret)

    if (error) {
      throw new DBError(error)
    }

    if (!data.length) {
      return undefined
    }

    const keyData = data[0]
    if (!keyData.keys.length) {
      return undefined
    }

    return {
      _id: keyData.keys[0]._id,
      name: keyData.keys[0].name,
      isDeleted: Boolean(keyData.keys[0].deleted_at),
      user: {
        _id: keyData._id,
        issuer: keyData.issuer
      }
    }
  }

  async checkIsTokenBlocked (token) {
    const { data, error } = await this._client
      .from('auth_key_history')
      .select('status')
      .filter('deleted_at', 'is', null)
      .eq('auth_key_id', token._id)
      .single()

    if (error) {
      throw new DBError(error)
    }

    return data?.status === 'Blocked'
  }

  /**
   * List auth keys of a given user.
   *
   * @param {number} userId
   * @return {Promise<Array<import('./db-client-types').AuthKeyItemOutput>>}
   */
  async listKeys (userId) {
    /** @type {{ error: PostgrestError, data: Array<import('./db-client-types').AuthKeyItem> }} */
    const { data, error } = await this._client.rpc('user_auth_keys_list', {
      query_user_id: userId
    })

    if (error) {
      throw new DBError(error)
    }

    return data.map((ki) => ({
      _id: ki.id,
      name: ki.name,
      secret: ki.secret,
      created: ki.created,
      hasUploads: ki.has_uploads
    }))
  }

  /**
   * Delete auth key with given id.
   *
   * @param {number} userId
   * @param {number} keyId
   */
  async deleteKey (userId, keyId) {
    const now = new Date().toISOString()
    /** @type {{ data, error: PostgrestError }} */
    const { data, error } = await this._client
      .from('auth_key')
      .update({
        deleted_at: now,
        updated_at: now
      })
      .match({
        id: keyId,
        user_id: userId
      })
      .is('deleted_at', null)

    if (error) {
      throw new DBError(error)
    }

    if (!data.length) {
      return undefined
    }

    return {
      _id: data[0].id
    }
  }

  /**
   * Get metrics for a given key.
   *
   * @param {string} key
   */
  async getMetricsValue (key) {
    const query = this._client.from('metric')
    const { data, error } = await query.select('value').eq('name', key)

    if (error) {
      throw new DBError(error)
    }

    if (!data || !data.length) {
      return undefined
    }

    return data[0].value
  }

  /**
   * Creates a Pin Request.
   *
   * @param {import('./db-client-types').PsaPinRequestUpsertInput} pinRequestData
   * @return {Promise<import('./db-client-types').PsaPinRequestUpsertOutput>}
   */
  async createPsaPinRequest (pinRequestData) {
    const now = new Date().toISOString()

    /** @type {{ data: string, error: PostgrestError }} */
    const { data: pinRequestId, error } = await this._client
      .rpc('create_psa_pin_request', {
        data: {
          auth_key_id: pinRequestData.authKey,
          content_cid: pinRequestData.contentCid,
          source_cid: pinRequestData.sourceCid,
          name: pinRequestData.name,
          origins: pinRequestData.origins,
          meta: pinRequestData.meta,
          dag_size: pinRequestData.dagSize,
          inserted_at: pinRequestData.created || now,
          updated_at: pinRequestData.updated || now,
          pins: pinRequestData.pins.map((pin) => ({
            status: pin.status,
            location: {
              peer_id: pin.location.peerId,
              peer_name: pin.location.peerName,
              ipfs_peer_id: pin.location.ipfsPeerId,
              region: pin.location.region
            }
          }))
        }
      })
      .single()

    if (error) {
      throw new DBError(error)
    }

    // TODO: this second request could be avoided by returning the right data
    // from create_psa_pin_request remote procedure. (But to keep this DRY we need to refactor
    // this a bit)
    return await this.getPsaPinRequest(pinRequestData.authKey, pinRequestId)
  }

  /**
   * Get a Pin Request by id
   *
   * @param {string} authKey
   * @param {number} pinRequestId
   * @return {Promise<import('./db-client-types').PsaPinRequestUpsertOutput>}
   */
  async getPsaPinRequest (authKey, pinRequestId) {
    /** @type {{data: import('./db-client-types').PsaPinRequestItem, error: PostgrestError }} */
    const { data, error } = await this._client
      .from(psaPinRequestTableName)
      .select(pinRequestSelect)
      .match({ auth_key_id: authKey, id: pinRequestId })
      .is('deleted_at', null)
      .single()

    if (error) {
      throw new DBError(error)
    }

    return normalizePsaPinRequest(data)
  }

  /**
   * Get a filtered list of pin requests for a user
   *
   * @param {string} authKey
   * @param {import('./db-client-types').ListPsaPinRequestOptions} [opts]
   * @return {Promise<import('./db-client-types').ListPsaPinRequestResults> }> }
   */
  async listPsaPinRequests (authKey, opts = {}) {
    const match = opts?.match || 'exact'
    const limit = opts?.limit || 10

    let query = this._client
      .from(psaPinRequestTableName)
      .select(listPinsQuery, {
        count: 'exact'
      })
      .eq('auth_key_id', authKey)
      .is('deleted_at', null)
      .limit(limit)
      .order('inserted_at', { ascending: false })

    if (!opts.cid && !opts.name && !opts.statuses) {
      query = query.eq('content.pins.status', 'Pinned')
    }

    if (opts.statuses) {
      query = query.in('content.pins.status', opts.statuses)
    }

    if (opts.cid) {
      query = query.in('source_cid', opts.cid)
    }

    if (opts.name) {
      switch (match) {
        case 'exact':
          query = query.like('name', `${opts.name}`)
          break
        case 'iexact':
          query = query.ilike('name', `${opts.name}`)
          break
        case 'partial':
          query = query.like('name', `%${opts.name}%`)
          break
        case 'ipartial':
          query = query.ilike('name', `%${opts.name}%`)
          break
      }
    }

    if (opts.before) {
      query = query.lte('inserted_at', opts.before)
    }

    if (opts.after) {
      query = query.gte('inserted_at', opts.after)
    }

    if (opts.meta) {
      // Match meta on all the key/values specified.
      for (const key in opts.meta) {
        const value = opts.meta[key]
        query = query.eq(`meta->>${key}`, value)
      }
    }

    /** @type {{ data: Array<import('./db-client-types').PsaPinRequestItem>, count: number, error: PostgrestError }} */
    const { data, count, error } = await query

    if (error) {
      throw new DBError(error)
    }

    const pins = data.map((pinRequest) => normalizePsaPinRequest(pinRequest))

    return {
      count,
      results: pins
    }
  }

  /**
   * Delete a user PA pin request.
   *
   * @param {number} requestId
   * @param {string} authKey
   */
  async deletePsaPinRequest (requestId, authKey) {
    const date = new Date().toISOString()
    /** @type {{ data: import('./db-client-types').PsaPinRequestItem, error: PostgrestError }} */
    const { data, error } = await this._client
      .from(psaPinRequestTableName)
      .update({
        deleted_at: date,
        updated_at: date
      })
      .match({ auth_key_id: authKey, id: requestId })
      .filter('deleted_at', 'is', null)
      .single()

    if (error) {
      throw new DBError(error)
    }

    return {
      _id: data.id
    }
  }

  /**
   * Get the raw IPNS record for a given key.
   *
   * @param {string} key
   */
  async resolveNameRecord (key) {
    /** @type {{ error: Error, data: Array<import('./db-client-types').NameItem> }} */
    const { data, error } = await this._client
      .from('name')
      .select('record')
      .match({ key })

    if (error) {
      throw new DBError(error)
    }

    return data.length ? data[0].record : undefined
  }

  /**
   * Publish a new IPNS record, ensuring the sequence number is greater than
   * the sequence number of an existing record for the given key.
   *
   * @param {string} key
   * @param {string} record Base 64 encoded serialized IPNS record.
   * @param {boolean} hasV2Sig If the record has a v2 signature.
   * @param {bigint} seqno Sequence number from the record.
   * @param {bigint} validity Validity from the record in nanoseconds since 00:00, Jan 1 1970 UTC.
   */
  async publishNameRecord (key, record, hasV2Sig, seqno, validity) {
    const { error } = await this._client.rpc('publish_name_record', {
      data: {
        key,
        record,
        has_v2_sig: hasV2Sig,
        seqno: seqno.toString(),
        validity: validity.toString()
      }
    })

    if (error) {
      throw new DBError(error)
    }
  }
}
