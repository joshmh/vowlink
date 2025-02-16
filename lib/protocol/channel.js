import { Buffer } from 'buffer';
import createDebug from 'debug';
import WaitList from 'promise-waitlist';

import { now, BanError } from '../utils';
import MemoryStorage from '../storage/memory';
import { Channel as PChannel } from '../messages';

import Chain from './chain';
import Message from './message';
import StorageCache from './cache';

const debug = createDebug('vowlink:channel');

export const ID_SIZE = 32;
export const MAX_PARENT_DELTA = 30 * 24 * 3600; // 30 days
export const MAX_QUERY_LIMIT = 1024;
export const MAX_UNRESOLVED_COUNT = 256 * 1024;
export const MAX_BULK_COUNT = 128;
export const MAX_LEAVES_COUNT = 128;

const ID_KEY = Buffer.from('vowlink-channel-id');
const ENC_KEY = Buffer.from('vowlink-symmetric');

const FUTURE = 2 * 60; // 2 minutes

export default class Channel {
  constructor(options = {}) {
    this.options = {
      maxQueryLimit: MAX_QUERY_LIMIT,
      maxUnresolvedCount: MAX_UNRESOLVED_COUNT,
      maxBulkCount: MAX_BULK_COUNT,
      ...options,
    };
    this.name = this.options.name;
    this.publicKey = this.options.publicKey;
    this.sodium = this.options.sodium;

    if (!this.sodium) {
      throw new Error('Missing required `sodium` option');
    }
    if (!this.name) {
      throw new Error('Missing required `name` option');
    }
    if (!this.publicKey) {
      throw new Error('Missing required `publicKey` option');
    }

    const sodium = this.sodium;

    this.id = Buffer.alloc(ID_SIZE);
    sodium.crypto_generichash(this.id, this.publicKey, ID_KEY);

    this.debugId = this.id.toString('hex').slice(0, 8) + '/' + this.name;

    this.encryptionKey = Buffer.alloc(sodium.crypto_secretbox_KEYBYTES);
    sodium.crypto_generichash(this.encryptionKey, this.publicKey, ENC_KEY);

    this.cache = new StorageCache({
      sodium,
      channelId: this.id,
      backend: this.options.storage || new MemoryStorage(),
      ...(this.options.cache || {}),
    });

    // To be JSON stringified and stored in persistence
    this.metadata = null;

    this.waitList = new WaitList();
  }

  equals(to) {
    return this.id.equals(to.id);
  }

  clear() {
    const sodium = this.sodium;

    if (sodium.sodium_memzero) {
      sodium.sodium_memzero(this.encryptionKey);
    } else {
      this.encryptionKey.fill(0);
    }

    this.waitList.close(new Error('Closed'));
  }

  getMetadata() {
    return this.metadata;
  }

  setMetadata(metadata) {
    this.metadata = metadata;
  }

  // Mostly for testing
  async getRoot() {
    const messages = await this.getMessagesAtOffset(0);
    if (messages.length === 0) {
      return null;
    }
    return messages[0];
  }

  // Create channel using identity and post an initial message
  static async fromIdentity(identity, options) {
    const channel = new Channel({
      ...options,
      name: options.name || identity.name,
      publicKey: identity.publicKey,
    });
    identity.addChain(channel, new Chain([]));

    const content = identity.signMessageBody(Message.root(), channel, {
      parents: [],
      height: 0,
    });
    const root = new Message({
      sodium: channel.sodium,

      channel,
      parents: [],
      height: 0,
      content,
    });

    await channel.receive(root);

    return channel;
  }

  static async fromInvite(invite, options) {
    const { identity } = options;
    if (!identity) {
      throw new Error('Missing required `identity` option');
    }

    const channel = new Channel({
      ...options,
      name: options.name || invite.channelName,
      publicKey: invite.channelPubKey,
    });
    const sodium = channel.sodium;
    const chain = Chain.deserialize(invite.chain, { sodium });
    identity.addChain(channel, chain);
    return channel;
  }

  static async fromPublicKey(publicKey, options) {
    const { name } = options;
    if (!name) {
      throw new Error('Missing required `name` option');
    }

    return new Channel({
      ...options,
      name,
      publicKey,
    });
  }

  waitForIncomingMessage(timeout) {
    return this.waitList.waitFor('incoming', timeout);
  }

  waitForOutgoingMessage(timeout) {
    return this.waitList.waitFor('outgoing', timeout);
  }

  waitForUpdate(timeout) {
    return this.waitList.waitFor('update', timeout);
  }

  async post(body, identity, { timestamp = now() } = {}) {
    if (body.root) {
      throw new Error('Posting root is not allowed');
    }

    const leaves = await this.getLeaves();

    const parents = this.filterParents(leaves);
    if (parents.length === 0) {
      const count = await this.getMessageCount();
      if (count === 0) {
        throw new Error('Initial synchronization not complete');
      }
      throw new Error('Internal error: no leaves');
    }

    const height = this.computeHeight(parents);
    timestamp = this.adjustTimestamp(parents, timestamp);
    const parentHashes = parents.map((parent) => parent.hash);

    const content = identity.signMessageBody(body, this, {
      parents: parentHashes,
      height,
      timestamp,
    });

    Channel.checkJSONLimit(body.json, content.chain.length);

    const message = new Message({
      sodium: this.sodium,

      channel: this,
      parents: parentHashes,
      height,
      content,
    });

    await this.cache.addMessage(message);
    this.debug('posted message.hash=%s', message.debugHash);

    this.waitList.resolve('outgoing', message);
    this.waitList.resolve('update');

    return message;
  }

  async receive(message) {
    // Duplicate
    if (await this.cache.hasMessage(message.hash)) {
      this.debug('received duplicate hash=%s', message.debugHash);
      return;
    }

    message.decrypt(this);

    //
    // Verify signature
    //
    if (!message.verify(this)) {
      throw new BanError('Invalid message signature, or invalid chain');
    }

    if (message.parents.length > MAX_LEAVES_COUNT) {
      throw new BanError('Invalid parent count: ' + message.parents.length);
    }

    //
    // Check parents and parent delta
    //
    const parents = await this.getMessages(message.parents);
    const missingIndex = parents.findIndex((parent) => !parent);
    if (missingIndex !== -1) {
      throw new BanError('Message parent: ' +
        `${message.parents[missingIndex].toString('hex')} not found`);
    }

    if (this.filterParents(parents).length !== parents.length) {
      throw new BanError('Parent timestamp delta is greater than 30 days');
    }

    //
    // Check height
    //

    const height = this.computeHeight(parents);
    if (message.height !== height) {
      throw new BanError(
        `Invalid received message height: ${message.height}, ` +
        `expected: ${height}`);
    }

    //
    // Check timestamp
    //

    const future = now() + FUTURE;
    if (message.content.timestamp > future) {
      throw new BanError('Received message is in the future');
    }

    const parentTimestamp = this.computeMaxTimestamp(parents);
    if (message.content.timestamp < parentTimestamp) {
      throw new BanError('Received message is in the past');
    }

    if (parents.length === 0) {
      if (!message.content.body.root) {
        throw new BanError('Invalid root content');
      }
    }

    if (parents.length !== 0) {
      if (message.content.body.root) {
        throw new BanError('Invalid non-root content');
      }

      Channel.checkJSONLimit(message.content.body.json,
        message.content.chain.length);
    }

    await this.cache.addMessage(message);
    this.debug('received message.hash=%s', message.debugHash);

    this.waitList.resolve('incoming', message);
    this.waitList.resolve('update');
  }

  async getMessageCount() {
    return await this.cache.getMessageCount();
  }

  async getMessagesAtOffset(offset, limit = 1) {
    const messages = await this.cache.getMessagesAtOffset(offset, limit);
    return messages.map((message) => {
      message.decrypt(this);
      return message;
    });
  }

  async getReverseMessagesAtOffset(offset, limit = 1) {
    const messages = await this.cache.getReverseMessagesAtOffset(
      offset, limit);
    return messages.map((message) => {
      message.decrypt(this);
      return message;
    });
  }

  async getEncryptedLeaves() {
    return await this.cache.getLeaves();
  }

  async getLeaves() {
    let leaves = await this.getEncryptedLeaves();
    leaves = leaves.slice(0, MAX_LEAVES_COUNT);

    return leaves.map((leaf) => {
      leaf.decrypt(this);
      return leaf;
    });
  }

  async getMessages(hashes) {
    const messages = await this.cache.getMessages(hashes);

    return messages.map((message) => {
      if (message) {
        message.decrypt(this);
      }
      return message;
    })
  }

  async getMinLeafHeight() {
    const leaves = await this.getEncryptedLeaves();
    return leaves.reduce((acc, leave) => {
      return Math.min(acc, leave.height);
    }, Number.MAX_SAFE_INTEGER);
  }

  async query(cursor, isBackward, limit) {
    if (cursor.hash) {
      Message.checkHash(cursor.hash, 'Invalid cursor.hash length in query()');

      this.debug('got query cursor.hash=%s isBackward=%j limit=%d',
        cursor.hash.toString('hex').slice(0, 8), isBackward, limit);
    } else {
      this.debug('got query cursor.height=%d isBackward=%j limit=%d',
        cursor.height, isBackward, limit);
    }

    limit = Math.min(limit || 0, this.options.maxQueryLimit);
    if (!cursor.hash) {
      cursor = {
        height: Math.min(cursor.height, await this.getMinLeafHeight()),
      };
    }

    const {
      abbreviatedMessages,
      forwardHash,
      backwardHash
    } = await this.cache.query(cursor, isBackward, limit);

    this.debug('query result messages.count=%d backward=%s forward=%s',
      abbreviatedMessages.length,
      backwardHash && backwardHash.toString('hex').slice(0, 8),
      forwardHash && forwardHash.toString('hex').slice(0, 8));

    return {
      abbreviatedMessages,
      forwardHash,
      backwardHash,
    };
  }

  async bulk(hashes) {
    this.debug('bulk request hashes.length=%d', hashes.length);
    hashes = hashes.slice(0, this.options.maxBulkCount);

    hashes.forEach((hash) => {
      Message.checkHash(hash, 'Invalid hash size in bulk()');
    });

    const maybeMessages = await this.getMessages(hashes);
    const messages = maybeMessages.filter((message) => {
      return !!message;
    });

    this.debug('bulk response messages.length=%d', messages.length);

    return {
      messages,
      forwardIndex: hashes.length,
    };
  }

  async sync(remote, isFull = false) {
    this.debug('starting sync to remote isFull=%j', isFull);

    // Starting cursor: height = minLeafHeight or height = 0 for full sync
    let cursor = isFull ? { height: 0 } :
      { height: await this.getMinLeafHeight() };

    const unresolved = new Set();
    for (;;) {
      const isBackward = unresolved.size !== 0;
      const response = await remote.query(cursor, isBackward,
        this.options.maxQueryLimit);
      if (response.abbreviatedMessages.length > this.options.maxQueryLimit) {
        throw new BanError('Query response overflow: ' +
          `${response.messages.length} > ${this.options.maxQueryLimit}`);
      }

      if (cursor.hash) {
        this.debug('sync cursor.hash=%j isBackward=%j count=%d',
          cursor.hash.toString('hex').slice(0, 8),
          isBackward,
          response.abbreviatedMessages.length);
      } else {
        this.debug('sync cursor.height=%j isBackward=%j count=%d',
          cursor.height,
          isBackward,
          response.abbreviatedMessages.length);
      }

      let { external, known } = await this.computePartialDAG(response);
      this.debug('partial dag external.count=%d known.count=%d',
        external.length, known.length);

      for (const abbr of response.abbreviatedMessages) {
        // Message is included in response, remove it from unresolved parents
        unresolved.delete(abbr.hash.toString('hex'));
      }

      // Request messages with known parents
      const expected = new Set(known.map((hash) => hash.toString('hex')));
      while (known.length !== 0) {
        const { messages, forwardIndex } = await remote.bulk(known);

        for (const message of messages) {
          const hexHash = message.hash.toString('hex');
          if (!expected.has(hexHash)) {
            throw new BanError(
              `Unexpected message in bulk response: ${hexHash}`);
          }

          await this.receive(message);
        }

        known = known.slice(forwardIndex);
      }

      if (isFull && external.length !== 0) {
        throw new BanError(
          'Synchronization failed. Missing parent in full sync');
      }

      // Add external dependencies to unresolved
      for (const hash of external) {
        unresolved.add(hash.toString('hex'));

        if (unresolved.size > this.options.maxUnresolvedCount) {
          this.debug('fallback to full sync');
          return await this.sync(remote, true);
        }
      }
      this.debug('unresolved.size=%d', unresolved.size);

      if (unresolved.size === 0) {
        // Everything resolved - go forward
        cursor = { hash: response.forwardHash };
      } else {
        cursor = { hash: response.backwardHash };
      }

      if (!cursor.hash) {
        break;
      }
    }

    this.debug('completed sync to remote isFull=%j', isFull);
  }

  //
  // Private
  //

  computeHeight(parents) {
    return parents.reduce((acc, parent) => {
      return Math.max(acc, parent.height + 1);
    }, 0);
  }

  adjustTimestamp(parents, timestamp) {
    return parents.reduce((acc, parent) => {
      return Math.max(acc, parent.content.timestamp);
    }, timestamp);
  }

  computeMaxTimestamp(parents) {
    return parents.reduce((acc, parent) => {
      return Math.max(acc, parent.content.timestamp);
    }, 0);
  }

  filterParents(parents) {
    const max = this.computeMaxTimestamp(parents);
    const min = max - MAX_PARENT_DELTA;

    return parents.filter((parent) => {
      return parent.content.timestamp >= min;
    });
  }

  async computePartialDAG(response) {
    // Hashes of parents outside of the response and storage
    const external = new Set();

    // Hashes of parents either in the response or in the storage
    const local = new Set();

    // Messages with known parents (including parents in response)
    const known = [];

    // Messages with some of parents unknown
    const unknown = new Set();

    for (const abbr of response.abbreviatedMessages) {
      local.add(abbr.hash.toString('hex'));

      let missingParents = 0;
      for (const parentHash of abbr.parents) {
        const parentHexHash = parentHash.toString('hex');
        if (unknown.has(parentHexHash)) {
          missingParents++;
          continue;
        }

        if (local.has(parentHexHash)) {
          continue;
        }

        const isKnown = await this.cache.hasMessage(parentHash);
        if (isKnown) {
          continue;
        }

        external.add(parentHexHash);
        missingParents++;
      }

      if (missingParents === 0) {
        const isPresent = await this.cache.hasMessage(abbr.hash);
        if (!isPresent) {
          known.push(abbr.hash);
        }
      } else {
        unknown.add(abbr.hash.toString('hex'));
      }
    }

    const externalHashes = Array.from(external).map((hex) => {
      return Buffer.from(hex, 'hex');
    });

    return { external: externalHashes, known };
  }

  //
  // Serialize/deserialize (for storage)
  //

  serialize() {
    return {
      publicKey: this.publicKey,
      name: this.name,

      metadata: this.metadata ? JSON.stringify(this.metadata) : '',
    };
  }

  serializeData() {
    return PChannel.encode(this.serialize()).finish();
  }

  static async deserialize(decoded, options) {
    const channel = new Channel({
      ...options,
      name: decoded.name,
      publicKey: decoded.publicKey,
    });
    if (decoded.metadata) {
      try {
        channel.setMetadata(JSON.parse(decoded.metadata));
      } catch (e) {
        channel.debug('failed to parse stored metadata');
      }
    }
    return channel;
  }

  static async deserializeData(data, options) {
    return await Channel.deserialize(PChannel.decode(data), options);
  }

  static compare(a, b) {
    if (a.name > b.name) {
      return 1;
    } else if (a.name < b.name) {
      return -1;
    } else {
      return 0;
    }
  }

  static checkId(id, message) {
    if (id.length !== ID_SIZE) {
      throw new BanError(message);
    }
  }

  static jsonLimit(chainLength) {
    switch (chainLength) {
      case 0: return Infinity;
      case 1: return 262144;
      case 2: return 8192;
      case 3: return 256;
      default: throw new Error('Unexpected chain length: ' + chainLength);
    }
  }

  static checkJSONLimit(json = '', chainLength) {
    const limit = Channel.jsonLimit(chainLength);
    if (json.length > limit) {
      throw new BanError('Message body length overflow. ' +
        `Expected less or equal to: ${limit}. ` +
        `Got: ${json.length}`);
    }
  }

  //
  // Debug
  //

  debug(format, ...args) {
    if (!debug.enabled) {
      return;
    }
    debug('[%s] ' + format, ...[ this.debugId ].concat(args));
  }
}

// Convenience
Channel.ID_SIZE = ID_SIZE;
Channel.MAX_PARENT_DELTA = MAX_PARENT_DELTA;
Channel.MAX_QUERY_LIMIT = MAX_QUERY_LIMIT;
Channel.MAX_UNRESOLVED_COUNT = MAX_UNRESOLVED_COUNT;
Channel.MAX_BULK_COUNT = MAX_BULK_COUNT;
Channel.MAX_LEAVES_COUNT = MAX_LEAVES_COUNT;
