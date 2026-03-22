export const DoubloonAbi = [
  // Read functions
  {
    inputs: [{ name: 'productId', type: 'bytes32' }, { name: 'user', type: 'address' }],
    name: 'isEntitled',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'productId', type: 'bytes32' }, { name: 'user', type: 'address' }],
    name: 'getEntitlement',
    outputs: [{
      components: [
        { name: 'productId', type: 'bytes32' },
        { name: 'user', type: 'address' },
        { name: 'grantedAt', type: 'uint64' },
        { name: 'expiresAt', type: 'int64' },
        { name: 'autoRenew', type: 'bool' },
        { name: 'source', type: 'uint8' },
        { name: 'sourceId', type: 'string' },
        { name: 'active', type: 'bool' },
        { name: 'revokedAt', type: 'uint64' },
        { name: 'revokedBy', type: 'address' },
        { name: 'exists', type: 'bool' },
      ],
      name: '',
      type: 'tuple',
    }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'productId', type: 'bytes32' }],
    name: 'getProduct',
    outputs: [{
      components: [
        { name: 'creator', type: 'address' },
        { name: 'productId', type: 'bytes32' },
        { name: 'name', type: 'string' },
        { name: 'metadataUri', type: 'string' },
        { name: 'createdAt', type: 'uint64' },
        { name: 'updatedAt', type: 'uint64' },
        { name: 'active', type: 'bool' },
        { name: 'frozen', type: 'bool' },
        { name: 'entitlementCount', type: 'uint64' },
        { name: 'delegateCount', type: 'uint16' },
        { name: 'defaultDuration', type: 'int64' },
        { name: 'exists', type: 'bool' },
      ],
      name: '',
      type: 'tuple',
    }],
    stateMutability: 'view',
    type: 'function',
  },
  // Platform
  { inputs: [], name: 'platformAuthority', outputs: [{ type: 'address' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'platformFrozen', outputs: [{ type: 'bool' }], stateMutability: 'view', type: 'function' },
  { inputs: [], name: 'productCount', outputs: [{ type: 'uint256' }], stateMutability: 'view', type: 'function' },
  // Write functions
  { inputs: [], name: 'initializePlatform', outputs: [], stateMutability: 'nonpayable', type: 'function' },
  {
    inputs: [{ name: 'newAuthority', type: 'address' }],
    name: 'transferPlatformAuthority', outputs: [], stateMutability: 'nonpayable', type: 'function',
  },
  {
    inputs: [
      { name: 'productId', type: 'bytes32' }, { name: 'name', type: 'string' },
      { name: 'metadataUri', type: 'string' }, { name: 'defaultDuration', type: 'int64' },
    ],
    name: 'registerProduct', outputs: [], stateMutability: 'nonpayable', type: 'function',
  },
  {
    inputs: [
      { name: 'productId', type: 'bytes32' }, { name: 'user', type: 'address' },
      { name: 'expiresAt', type: 'int64' }, { name: 'source', type: 'uint8' },
      { name: 'sourceId', type: 'string' }, { name: 'autoRenew', type: 'bool' },
    ],
    name: 'mintEntitlement', outputs: [], stateMutability: 'nonpayable', type: 'function',
  },
  {
    inputs: [
      { name: 'productId', type: 'bytes32' }, { name: 'user', type: 'address' },
    ],
    name: 'revokeEntitlement', outputs: [], stateMutability: 'nonpayable', type: 'function',
  },
  // Events
  {
    inputs: [
      { indexed: true, name: 'productId', type: 'bytes32' },
      { indexed: true, name: 'user', type: 'address' },
      { indexed: false, name: 'expiresAt', type: 'int64' },
      { indexed: false, name: 'source', type: 'uint8' },
    ],
    name: 'EntitlementMinted', type: 'event',
  },
  {
    inputs: [
      { indexed: true, name: 'productId', type: 'bytes32' },
      { indexed: true, name: 'user', type: 'address' },
      { indexed: false, name: 'revokedBy', type: 'address' },
    ],
    name: 'EntitlementRevoked', type: 'event',
  },
] as const;
