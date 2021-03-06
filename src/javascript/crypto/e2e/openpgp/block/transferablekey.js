/**
 * @license
 * Copyright 2013 Google Inc. All rights reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview Base class for transferable OpenPGP key blocks.
 * @author evn@google.com (Eduardo Vela)
 */

goog.provide('e2e.openpgp.block.TransferableKey');

goog.require('e2e');
goog.require('e2e.debug.Console');
goog.require('e2e.openpgp.block.Block');
goog.require('e2e.openpgp.error.ParseError');
goog.require('e2e.openpgp.error.SignatureError');
goog.require('e2e.openpgp.packet.PublicSubkey');
goog.require('e2e.openpgp.packet.SecretSubkey');
goog.require('e2e.openpgp.packet.Signature');
goog.require('e2e.openpgp.packet.Trust');
goog.require('e2e.openpgp.packet.UserAttribute');
goog.require('e2e.openpgp.packet.UserId');
goog.require('goog.array');
goog.require('goog.asserts');
goog.require('goog.async.DeferredList');



/**
 * Representation of a transferable key block. According to the OpenPGP RFC
 * (RFC 4880) Section 11.1/2, a transferable key block is represented as:
 *  - One Public-Key or Secret-Key packet
 *  - Zero or more revocation signatures
 *  - One or more User ID packets
 *  - After each User ID packet, zero or more Signature packets
 *    (certifications)
 *  - Zero or more User Attribute packets
 *  - After each User Attribute packet, zero or more Signature packets
 *    (certifications)
 *  - Zero or more Subkey packets
 *  - After each Subkey packet, one Signature packet, plus optionally a
 *    revocation
 * @param {function(new:e2e.openpgp.packet.Key, number, number,
 *     !e2e.cipher.Cipher, !e2e.ByteArray)} keyPacketClass The
 *     class of key packet to parse.
 * @constructor
 * @extends {e2e.openpgp.block.Block}
 */
e2e.openpgp.block.TransferableKey = function(keyPacketClass) {
  /**
   * The class of key packet to extract.
   * @type {function(new:e2e.openpgp.packet.Key,
   *     number, number, !e2e.cipher.Cipher, !e2e.ByteArray)}
   */
  this.keyPacketClass = keyPacketClass;
  /**
   * Main key, public or private, for this block.
   * @type {?e2e.openpgp.packet.Key}
   */
  this.keyPacket = null;
  /**
   * List of all user IDs in this block, regardless the validity of their
   * signatures. Used for the key serialization only.
   * @private {!Array.<!e2e.openpgp.packet.UserId>}
   */
  this.unverifiedUserIds_ = [];
  /**
   * List of valid user IDs in this block. Use {@link #processSignatures} to
   * populate this list.
   * @type {!Array.<!e2e.openpgp.packet.UserId>}
   */
  this.userIds = [];
  /**
   * List of all subkeys in this block, regardless the validity of their
   * signatures. Used for the key serialization only.
   * @private {!Array.<!e2e.openpgp.packet.Key>}
   */
  this.unverifiedSubKeys_ = [];
  /**
   * List of valid subkeys in this block. Use {@link #processSignatures} to
   * populate this list.
   * @type {!Array.<!e2e.openpgp.packet.Key>}
   */
  this.subKeys = [];
  /**
   * List of all user attributes in this block, regardless the validity of their
   * signatures. Used for the key serialization only.
   * @private {!Array.<!e2e.openpgp.packet.UserAttribute>}
   */
  this.unverifiedUserAttributes_ = [];
  /**
   * List of valid user attributes in this block. Use {@link #processSignatures}
   * to populate this list.
   * @type {!Array.<!e2e.openpgp.packet.UserAttribute>}
   */
  this.userAttributes = [];

  goog.base(this);
};
goog.inherits(e2e.openpgp.block.TransferableKey,
    e2e.openpgp.block.Block);


/**
 * Returns the verified user IDs.
 * @return {!Array.<string>} The User IDs for this key block.
 */
e2e.openpgp.block.TransferableKey.prototype.getUserIds = function() {
  return goog.array.map(this.userIds, function(uid) {return uid.userId;});
};


/** @inheritDoc */
e2e.openpgp.block.TransferableKey.prototype.parse = function(packets) {
  var packet = packets[0];
  if (packet instanceof this.keyPacketClass) {
    this.keyPacket = packet;
    this.packets.push(packets.shift());
  } else {
    throw new e2e.openpgp.error.ParseError(
        'Invalid block. Missing primary key packet.');
  }
  packet = packets[0];
  while (packet instanceof e2e.openpgp.packet.Signature) {
    if (packet.signatureType !==
        e2e.openpgp.packet.Signature.SignatureType.KEY_REVOCATION) {
      throw new e2e.openpgp.error.ParseError(
          'Invalid block. Only key revocation signatures are allowed after ' +
          'key packets.');
    }
    this.keyPacket.addRevocation(packet);
    this.packets.push(packets.shift());
    packet = packets[0];
  }
  while (packet instanceof e2e.openpgp.packet.UserId ||
      packet instanceof e2e.openpgp.packet.UserAttribute) {
    // Be compatible with GnuPG that creates invalid OpenPGP blocks intertwining
    // UserId and UserAttribute sequences. According to
    // http://tools.ietf.org/html/rfc4880#section-11.1 UserId sequences should
    // always come first. See Issue #33.
    while (packet instanceof e2e.openpgp.packet.UserId) {
      // UserAttribute extends UserId
      if (packet instanceof e2e.openpgp.packet.UserAttribute) {
        this.unverifiedUserAttributes_.push(packet);
      } else {
        this.unverifiedUserIds_.push(packet);
      }
      var userIdOrAttribute = packet;
      this.packets.push(packets.shift());
      packet = packets[0];
      while (packet instanceof e2e.openpgp.packet.Signature) {
        // TODO(koto): Figure out what to do with foreign certifications
        if (packet.isCertificationSignature()) {
          userIdOrAttribute.addCertification(packet);
        } else if (packet.signatureType === e2e.openpgp.packet.Signature.
            SignatureType.CERTIFICATION_REVOCATION) {
          userIdOrAttribute.addRevocation(packet);
        }
        this.packets.push(packets.shift());
        while (packets[0] instanceof e2e.openpgp.packet.Trust) {
          packets.shift();
        }
        packet = packets[0];
      }
    }
  }
  if (this.unverifiedUserIds_.length < 1) {
    throw new e2e.openpgp.error.ParseError('Invalid block. Missing User ID.');
  }
  while (packet instanceof e2e.openpgp.packet.PublicSubkey ||
      packet instanceof e2e.openpgp.packet.SecretSubkey) {
    var subKey = packet;
    this.unverifiedSubKeys_.push(packet);
    this.packets.push(packets.shift());
    packet = packets[0];
    // RFC4880 requires a signature for subkeys, however some clients, such as
    // PGP 8.0.3, do not include signatures on secretsubkeys.
    // Some keys apparently have more than one signature per subkey.
    // GnuPG puts subkey revocation signatures before subkey signatures, and it
    // does not contradict RFC 4880.
    while (packet instanceof e2e.openpgp.packet.Signature) {
      // Process subkey signatures.
      if (packet.signatureType ==
          e2e.openpgp.packet.Signature.SignatureType.SUBKEY) {
        // TODO(koto): Add support for signing key not being the main key.
        subKey.addBindingSignature(packet);
        this.packets.push(packets.shift());
        // Ignore trust packets.
        while (packets[0] instanceof e2e.openpgp.packet.Trust) {
          packets.shift();
        }
        packet = packets[0];
      } else if (packet.signatureType ==
                 e2e.openpgp.packet.Signature.SignatureType.SUBKEY_REVOCATION) {
        subKey.addRevocation(packet);
        this.packets.push(packets.shift());
        packet = packets[0];
      } else {
        break;
      }
    }
  }
  return packets;
};


/**
 * Verify all certification, binding and revocation signatures present in
 *     key block. This will remove all keys and User IDs with non-verifying or
 *     missing signatures. Revoked keys and User IDs are also removed.
 *  This method will throw an error if the resulting TransferableKey has no
 *  user IDs or any signature has been tampered with.
 *  @return {!e2e.async.Result<undefined>}
 */
e2e.openpgp.block.TransferableKey.prototype.processSignatures = function() {
  var signingKey = goog.asserts.assertObject(this.keyPacket);

  this.subKeys = [];
  this.userIds = [];
  this.userAttributes = [];

  return this.keyPacket.verifySignatures(signingKey)
      .addCallback(function(mainKeyVerified) {
        if (!mainKeyVerified) {
          // main key is invalid
          throw new e2e.openpgp.error.SignatureError(
             'Main key is invalid.');
        }
        var pendingVerifies = [];
        // Process subkeys
        this.unverifiedSubKeys_.forEach(function(subKey) {
          pendingVerifies.push(subKey.verifySignatures(signingKey)
             .addCallback(function(didVerify) {
               if (didVerify) {
                 this.subKeys.push(subKey);
               }
             }, this));
        }, this);
        // Process user IDs
        this.unverifiedUserIds_.forEach(function(userId) {
          pendingVerifies.push(userId.verifySignatures(signingKey)
             .addCallback(function(didVerify) {
               if (!didVerify) {
                 e2e.openpgp.block.TransferableKey.console_.warn(
                 'No valid signatures found for ', userId.userId);
               } else {
                 this.userIds.push(userId);
               }
             }, this));
        }, this);
        this.unverifiedUserAttributes_.forEach(function(attribute) {
          pendingVerifies.push(attribute.verifySignatures(signingKey)
             .addCallback(function(didVerify) {
               if (didVerify) {
                 this.userAttributes.push(attribute);
               }
             }, this));
        }, this);
        return goog.async.DeferredList.gatherResults(pendingVerifies);
      }, this).addCallback(function(ignored) {
        if (this.userIds.length == 0) {
          throw new e2e.openpgp.error.SignatureError('No certified user IDs.');
        }
      }, this);
};


/**
 * Chooses a key packet for the specified use.
 * @param {!e2e.openpgp.packet.Key.Usage} use The use of the key.
 * @param {function(new:T, ...)} type The constructor of the key to get.
 * @return {T} A key packet of the specified type.
 * @template T
 * @protected
 */
e2e.openpgp.block.TransferableKey.prototype.getKeyTo = function(use, type) {
  // First see if we have a subkey that satisfies the use, and pick
  // the newest if we have multiple viable subkeys.
  var subkey = this.getNewestCertifiedSubkeyTo_(use, type);

  if (!goog.isNull(subkey)) {
    return subkey;
  }

  // No subkeys match, so see if the primary key can be used.
  if (!this.keyPacket.can(use) || !(this.keyPacket instanceof type)) {
    return null;
  }

  // Get certified key-usage flags for the primary key from the uid
  // self-signatures.
  // We should really use a specific userid to get the most appropriate
  // key-usage information for the primary key. Instead, we find it from
  // the most recently self-certified userid signature.
  var userId = this.getNewestCertifiedUserId_();
  if (userId.isCertifiedTo(this.keyPacket, use)) {
    return this.keyPacket;
  }

  // No certifications found either in subkeys, or in the primary
  // key for the given use.
  e2e.openpgp.block.TransferableKey.console_.warn(
      'No keys available for', use);

  return null;
};


/**
 * Chooses a public key packet for encryption.
 * @return {e2e.openpgp.packet.PublicKey}
 */
e2e.openpgp.block.TransferableKey.prototype.getKeyToEncrypt =
    goog.abstractMethod;


/**
 * Chooses a secret key packet for decryption.
 * @return {e2e.openpgp.packet.SecretKey}
 */
e2e.openpgp.block.TransferableKey.prototype.getKeyToDecrypt =
    goog.abstractMethod;


/**
 * Chooses a secret key packet for signing.
 * @return {e2e.openpgp.packet.SecretKey}
 */
e2e.openpgp.block.TransferableKey.prototype.getKeyToSign =
    goog.abstractMethod;


/**
 * True if the key contains material that can be serialized in Key objects.
 * @type {boolean}
 */
e2e.openpgp.block.TransferableKey.prototype.SERIALIZE_IN_KEY_OBJECT = false;


/**
 * Returns a key or one of the subkeys of a given key ID.
 * @param {!e2e.openpgp.KeyId} keyId Key ID to find the key by.
 * @return {?e2e.openpgp.packet.Key} Found key
 */
e2e.openpgp.block.TransferableKey.prototype.getKeyById = function(keyId) {
  if (this.keyPacket.keyId &&
      e2e.compareByteArray(this.keyPacket.keyId, keyId)) {
    return this.keyPacket;
  }
  return goog.array.find(this.subKeys, function(key) {
    return !!key.keyId && e2e.compareByteArray(key.keyId, keyId);
  });
};


/**
 * Checks if a key or one of the subkeys has a given key ID.
 * @param {!e2e.openpgp.KeyId} keyId Key ID to find the key by.
 * @return {boolean} If true, this TransferableKey has a key with given ID.
 */
e2e.openpgp.block.TransferableKey.prototype.hasKeyById = function(keyId) {
  return !!this.getKeyById(keyId);
};


/** @inheritDoc */
e2e.openpgp.block.TransferableKey.prototype.serialize = function() {
  return goog.array.flatten(goog.array.map(
      [this.keyPacket]
      .concat(this.unverifiedUserIds_)
      .concat(this.unverifiedSubKeys_),
      function(packet) {
        return packet.serialize();
      }));
};


/**
 * Creates a Key object representing the TransferableKey.
 * @param {boolean=} opt_dontSerialize if true, skip key serialization in
 *     results.
 * @param {!e2e.openpgp.KeyProviderId=} opt_keyProviderId Key provider ID
 *     hints for secret key objects will be populated.
 * @return {!e2e.openpgp.Key}
 */
e2e.openpgp.block.TransferableKey.prototype.toKeyObject = function(
    opt_dontSerialize, opt_keyProviderId) {
  var keyProviderId = /** @type {!e2e.openpgp.KeyProviderId} */ (
      opt_keyProviderId || 'UnknownProvider');
  var keyObject = {
    key: this.keyPacket.toKeyPacketInfo(),
    subKeys: goog.array.map(
        this.subKeys, function(subKey) {
          return subKey.toKeyPacketInfo();
        }),
    uids: this.getUserIds(),
    serialized: /** @type {!e2e.ByteArray} */(
        (opt_dontSerialize || !this.SERIALIZE_IN_KEY_OBJECT) ?
        [] : this.serialize()),
    providerId: keyProviderId,
    signingKeyId: null,
    signAlgorithm: null,
    signHashAlgorithm: null,
    decryptionKeyId: null,
    decryptionAlgorithm: null,
  };
  if (keyObject.key.secret) {
    // Populate metadata to enable surrogate keys.
    var keyPacket = this.getKeyToSign();
    if (keyPacket) {
      keyObject.signingKeyId = goog.asserts.assertArray(keyPacket.keyId);
      keyObject.signAlgorithm = /** @type {!e2e.signer.Algorithm} */
          (goog.asserts.assertString(keyPacket.cipher.algorithm));
      keyObject.signHashAlgorithm = goog.asserts.assertString(
          keyPacket.cipher.getHashAlgorithm());
    }
    keyPacket = this.getKeyToDecrypt();
    if (keyPacket) {
      keyObject.decryptionKeyId = goog.asserts.assertArray(keyPacket.keyId);
      keyObject.decryptionAlgorithm = /** @type {!e2e.cipher.Algorithm} */
          (goog.asserts.assertString(keyPacket.cipher.algorithm));
    }
  }
  return keyObject;
};


/**
 * Choose the newest certified subkey that satisfies the given
 * use, or null if none are avaliable.
 * Will raise an exception if there are any uncertified subkeys.
 * @param {!e2e.openpgp.packet.Key.Usage} use The use of the key.
 * @param {function(new:T, ...)} type The constructor of the key to get.
 * @return {T} A key packet of the specified type.
 * @template T
 * @private
 */
e2e.openpgp.block.TransferableKey.prototype.getNewestCertifiedSubkeyTo_ =
    function(use, type) {
  var latestSubkey = null;
  // The most recent certification time on viable candidate keys.
  // Epoch seconds, initially set to a negative (minimum, but invalid)
  // value.
  // https://tools.ietf.org/html/rfc4880#section-3.5
  var latestTimestamp = -1;

  var mainKey = this.keyPacket;
  if (!goog.isDefAndNotNull(mainKey)) {
    throw new e2e.openpgp.error.SignatureError(
        'Main key has not been initialized.');
  }

  goog.array.forEach(this.subKeys, function(subkey) {
    var curTimestamp = subkey.getCertifiedTime(
        goog.asserts.assertObject(mainKey));
    if (curTimestamp >= latestTimestamp &&
        subkey.can(use) && subkey instanceof type &&
        subkey.isCertifiedTo(
            goog.asserts.assertObject(mainKey), use)) {
      latestTimestamp = curTimestamp;
      latestSubkey = subkey;
    }
  }, this);

  return latestSubkey;
};


/**
 * Select the newest certified User ID.
 * Will raise an exception if there are any uncertified User IDs, or
 * if there are no certified User IDs.
 * @return {!e2e.openpgp.packet.UserId}
 * @private
 */
e2e.openpgp.block.TransferableKey.prototype.getNewestCertifiedUserId_ =
    function() {
  var latestUserId;
  // The most recent certification time on viable candidate User IDs.
  // Epoch seconds, initially set to a negative (minimum, but invalid)
  // value.
  // https://tools.ietf.org/html/rfc4880#section-3.5
  var latestTimestamp = -1;

  var mainKey = this.keyPacket;
  if (!goog.isDefAndNotNull(mainKey)) {
    throw new e2e.openpgp.error.SignatureError(
        'Main key has not been initialized.');
  }

  goog.array.forEach(this.userIds, function(userId) {
    var curTimestamp = userId.getCertifiedTime(
        goog.asserts.assertObject(mainKey));
    if (curTimestamp >= latestTimestamp) {
      latestTimestamp = curTimestamp;
      latestUserId = userId;
    }
  }, this);
  if (!goog.isDefAndNotNull(latestUserId)) {
    throw new e2e.openpgp.error.SignatureError(
        'No certified User IDs available.');
  }
  return latestUserId;
};


/**
 * Adds a Sub Key packet to this block. The added packet is not verified yet,
 * use {@link #processSignatures} to be able to use it.
 * @param {!e2e.openpgp.packet.Key} subKey the Sub Key packet.
 */
e2e.openpgp.block.TransferableKey.prototype.addUnverifiedSubKey = function(
    subKey) {
  this.unverifiedSubKeys_.push(subKey);
};


/**
 * Adds a User ID packet to this block. The added packet is not verified yet,
 * use {@link #processSignatures} to be able to use it.
 * @param {!e2e.openpgp.packet.UserId} userId the User ID packet.
 */
e2e.openpgp.block.TransferableKey.prototype.addUnverifiedUserId = function(
    userId) {
  this.unverifiedUserIds_.push(userId);
};


/**
 * @type {!e2e.debug.Console}
 * @private
 */
e2e.openpgp.block.TransferableKey.console_ =
    e2e.debug.Console.getConsole('e2e.openpgp.block.TransferableKey');
