'use strict';

var hashValue = require('./build/Release/hashvalue')
  , SimpleCache = require("simple-lru-cache")
  , parse = require('connection-parse')
  , crypto = require('crypto');

/**
 * Add a virtual node parser to the connection string parser.
 *
 * @param {Object} data server data
 * @param {Mixed} value optional value
 * @api private
 */
parse.extension('vnodes', function vnode(data, value) {
  if (typeof value === 'object' && !Array.isArray(value) && 'vnodes' in value) {
    data.vnodes = +value.vnodes || 0;
  } else {
    data.vnodes = 0;
  }
});

/**
 * HashRing implements consistent hashing so adding or removing servers of one
 * slot does not significantly change the mapping of the key to slots. The
 * consistent hashing algorithm is based on ketama or libketama.
 *
 * @constructor
 * @param {Mixed} server Servers that need to be added to the ring
 * @param {Mixed} algorithm Either a Crypto compatible algorithm or custom hasher
 * @param {Object} options Optional configuration and options for the ring
 */
function HashRing(servers, algorithm, options) {
  options = options || {};

  // These properties can be configured
  this.pps = options['points per server'] || 160;     // Points per server
  this.vnode = options['vnode count'] || 40;          // Virtual nodes per server
  this.algorithm = algorithm || 'md5';                // Hashing algorithm

  // There's a slight difference between libketama and python's hash_ring
  // module, libketama creates 160 points per server:
  //
  //   40 hashes (vnodes) and 4 replicas per hash = 160 points per server
  //
  // The hash_ring module only uses 120 points per server:
  //
  //   40 hashes (vnodes) and 3 replicas per hash = 160 points per server
  //
  // And that's the only difference between the original ketama hash and the
  // hash_ring package. Small, but important.
  this.replicas = options.compatibility
    ? (options.compatibility === 'hash_ring' ? 3 : 4)
    : 4;

  // Private properties
  var connections = parse(servers);

  this.ring = [];
  this.size = 0;
  this.vnodes = connections.vnodes;
  this.servers = connections.servers;

  // Set up a ache as we don't want to preform a hashing operation every single
  // time we lookup a key.
  this.cache = new SimpleCache({
    maxSize: options.maxCacheSize || 5000
  });

  // Override the hashing function if people want to use a hashing algorithm
  // that is not supported by Node, for example if you want to MurMur hashing or
  // something else exotic.
  if ('function' === typeof this.algorithm) {
    this.hash = this.algorithm;
  }

  // Generate the continuum of the HashRing.
  this.continuum();
}

/**
 * Generates the continuum of server a.k.a the Hash Ring based on their weights
 * and virtual nodes assigned.
 *
 * @api private
 */
HashRing.prototype.continuum = function generate() {
  var servers = this.servers
    , self = this
    , index = 0
    , total = 0;

  // No servers, bailout
  if (!servers.length) return this;

  // Generate the total weight of all the servers
  total = servers.reduce(function reduce(total, server) {
    return total + server.weight;
  }, 0);

  servers.forEach(function each(server) {
    var percentage = server.weight / total
      , vnodes = self.vnodes[server.string] || self.vnode
      , length = Math.floor(percentage * vnodes * servers.length)
      , key
      , x;

    for (var i = 0; i < length; i++) {
      x = self.digest(server.string +'-'+ i);

      for (var j = 0; j < self.replicas; j++) {
        key = hashValue.hash(x[3 + j * 4], x[2 + j * 4], x[1 + j * 4], x[j * 4]);
        self.ring[index] = new Node(key, server.string);
        index++;
      }
    }
  });

  // Sort the keys
  this.ring = this.ring.sort(function sorted(a, b) {
    return (a.value < b.value) ? -1 : (a.value > b.value) ? 1 : 0;
  });

  this.size = this.ring.length;
  return this;
};

/**
 * Find the correct node for the key which is closest to the point after what
 * the given key hashes to.
 *
 * @param {String} key
 * @returns {String} server
 * @api public
 */
HashRing.prototype.get = function get(key) {
  var cache = this.cache.get(key);
  if (cache) return cache;

  var node = this.ring[this.find(this.hashValue(key))];
  if (!node) return undefined;

  this.cache.set(key, node.server);
  return node.server;
};

/**
 * Find the correct node for the key which is closest to the point after what
 * the given key hashes to.
 *
 * @param {Number} hashValue find the nearest server close to this hash
 * @returns {Number} position of the server in the hash ring
 * @api public
 */
HashRing.prototype.find = function find(hashValue) {
  var ring = this.ring
    , high = this.size
    , low = 0
    , middle
    , prev
    , mid;

  // Preform a search on the array to find the server with the next biggest
  // point after what the given key hashes to
  while (true) {
    mid = (low + high) >> 1;

    if (mid === this.size) return 0;

    middle = ring[mid].value;
    prev = mid === 0 ? 0 : ring[mid - 1].value;

    if (hashValue <= middle && hashValue > prev) return mid;

    if (middle < hashValue) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }

    if (low > high) return 0;
  }
};

/**
 * Generates a hash of the string.
 *
 * @param {String} key
 * @returns {String} hash
 * @api private
 */
HashRing.prototype.hash = function hash(key) {
  return crypto.createHash(this.algorithm).update(key).digest();
};

/**
 * Digest hash so we can make a numeric representation from the hash.
 *
 * @param {String} key The key that needs to be hashed
 * @returns {Array}
 * @api private
 */
HashRing.prototype.digest = function digest(key) {
  return this.hash(key +'').toString().split('').map(function charCode(char) {
    return char.charCodeAt(0);
  });
};

/**
 * Get the hashed value for the given key
 *
 * @param {String} key
 * @returns {Number}
 * @api private
 */
HashRing.prototype.hashValue = function hasher(key) {
  var x = this.digest(key);

  return hashValue.hash(x[3], x[2], x[1], x[0]);
};

/**
 * None ketama:
 *
 * The following changes are not ported from the ketama algorithm and are hash
 * ring specific. Add, remove or replace servers with as less disruption as
 * possible.
 */

/**
 * Get a range of different servers.
 *
 * @param {String} key
 * @param {Number} size Amount of servers it should return
 * @param {Boolean} unique Return only unique keys
 * @api public
 */
HashRing.prototype.range = function range(key, size, unique) {
  if (!this.size) return [];

  size = size || this.servers.length;
  unique = unique || 'undefined' === typeof unique;

  var position = this.find(this.hashValue(key))
    , length = this.ring.length
    , servers = []
    , node;

  // Start searching for servers from the postion of the key to the end of
  // HashRing.
  for (var i = position; i < length; i++) {
    node = this.ring[i];

    // Do we need to make sure that we retrieve a unique list of servers?
    if (unique) {
      if (!~servers.indexOf(node.server)) servers.push(node.server);
    } else {
      servers.push(node.server);
    }

    if (servers.length === size) return servers;
  }

  // Not enough results yet, so iterate from the start of the hash ring to the
  // position of the hash ring. So we reach full circle again.
  for (i = 0; i < position; i++) {
    node = this.ring[i];

    // Do we need to make sure that we retrieve a unique list of servers?
    if (unique) {
      if (!~servers.indexOf(node.server)) servers.push(node.server);
    } else {
      servers.push(node.server);
    }

    if (servers.length === size) return servers;
  }

  return servers;
};

/**
 * Returns the points per server.
 *
 * @param {String} server Optional server to filter down
 * @returns {Object} server -> Array(points)
 * @api public
 */
HashRing.prototype.points = function points(servers) {
  servers = Array.isArray(servers) ? servers : Object.keys(this.vnodes);

  var nodes = Object.create(null)
    , node;

  servers.forEach(function servers(server) {
    nodes[server] = [];
  });

  for (var i = 0; i < this.size; i++) {
    node = this.ring[i];

    if (node.server in nodes) {
      nodes[node.server].push(node.value);
    }
  }

  return nodes;
};

/**
 * Hotswap identical servers with each other. This doesn't require the cache to
 * be completely nuked and the hash ring distribution to be re-calculated.
 *
 * Please note that removing the server and a new adding server could
 * potentially create a different distribution.
 *
 * @param {String} from The server that needs to be replaced
 * @param {String} to The server that replaces the server
 * @api public
 */
HashRing.prototype.swap = function swap(from, to) {
  var connection = parse(to).servers.pop()
    , self = this;

  this.ring.forEach(function forEach(node) {
    if (node.server === from) node.server = to;
  });

  this.cache.forEach(function forEach(value, key) {
    if (value === from) self.cache.set(key, to);
  }, this);

  // Update the virtual nodes
  this.vnodes[to] = this.vnodes[from];
  delete this.vnodes[from];

  // Update the servers
  this.servers = this.servers.map(function mapswap(server) {
    if (server.string === from) {
      server.string = to;
      server.host = connection.host;
      server.port = connection.port;
    }

    return server;
  });

  return this;
};

/**
 * Add a new server to ring without having to re-initialize the hashring. It
 * accepts the same arguments as you can use in the constructor.
 *
 * @param {Mixed} servers Servers that need to be added to the ring
 * @api public
 */
HashRing.prototype.add = function add(servers) {
  var connections = Object.create(null);

  // Add the current servers to the set.
  this.servers.forEach(function forEach(server) {
    connections[server.string] = server;
  });

  parse(servers).servers.forEach(function forEach(server) {
    // Don't add duplicate servers
    if (server.string in connections) return;
    connections[server.string] = server;
  });

  // Now that we generated a complete set of servers, we can update the re-parse
  // the set and correctly added all the servers again
  connections = parse(connections);
  this.vnodes = connections.vnodes;
  this.servers = connections.servers;

  // Rebuild the hash ring
  this.reset();
  return this.continuum();
};

/**
 * Remove a server from the hashring.
 *
 * @param {Mixed} server
 * @api public
 */
HashRing.prototype.remove = function remove(server) {
  var connection = parse(server).servers.pop();

  delete this.vnodes[connection.string];
  this.servers = this.servers.map(function map(server) {
    if (server.string === connection.string) return undefined;

    return server;
  }).filter(Boolean);

  // Rebuild the hash ring
  this.reset();
  return this.continuum();
};

/**
 * Reset the HashRing to clean up all references
 *
 * @api public
 */
HashRing.prototype.reset = function reset() {
  this.ring.length = 0;
  this.size = 0;
  this.cache.reset();

  return this;
};

HashRing.prototype.end = function end() {
  this.reset();

  this.vnodes = {};
  this.servers.length = 0;

  return this;
};

/**
 * A single Node in our hash ring.
 *
 * @constructor
 * @param {Number} hashvalue
 * @param {String} server
 * @api private
 */
function Node(hashvalue, server) {
  this.value = hashvalue;
  this.server = server;
}

/**
 * Set up the legacy API aliases. These will be depricated in the next release.
 *
 * @api public
 */
[
  { from: 'replaceServer' },
  { from: 'replace' },
  { from: 'removeServer', to: 'remove' },
  { from: 'addServer', to: 'add' },
  { from: 'getNode', to: 'get' },
  { from: 'getNodePosition', to: 'find' },
  { from: 'position', to: 'find' }
].forEach(function depricate(api) {
  var notified = false;

  HashRing.prototype[api.from] = function depricating() {
    if (!notified) {
      console.warn();
      console.warn('[depricated] HashRing#'+ api.from +' is removed.');

      // Not every API has a replacement API that should be used
      if (api.to) {
        console.warn('[depricated] use HashRing#'+ api.to +' as replacement.');
      } else {
        console.warn('[depricated] the API has no replacement');
      }

      console.warn();
      notified = true;
    }

    if (api.to) return HashRing.prototype[api.to].apply(this, arguments);
  };
});

/**
 * Expose the current version number.
 *
 * @type {String}
 */
HashRing.version = require('./package.json').version;

/**
 * Expose the module.
 *
 * @api public
 */
module.exports = HashRing;
