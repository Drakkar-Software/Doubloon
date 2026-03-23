// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Doubloon {
    address public platformAuthority;
    bool public platformFrozen;
    uint256 public productCount;

    struct Product {
        address creator;
        bytes32 productId;
        string name;
        string metadataUri;
        uint64 createdAt;
        uint64 updatedAt;
        bool active;
        bool frozen;
        uint64 entitlementCount;
        uint16 delegateCount;
        int64 defaultDuration;
        bool exists;
    }

    struct MintDelegateData {
        bytes32 productId;
        address delegate;
        address grantedBy;
        uint64 grantedAt;
        int64 expiresAt;
        uint64 maxMints;
        uint64 mintsUsed;
        bool active;
        bool exists;
    }

    struct EntitlementData {
        bytes32 productId;
        address user;
        uint64 grantedAt;
        int64 expiresAt;
        bool autoRenew;
        uint8 source;
        string sourceId;
        bool active;
        uint64 revokedAt;
        address revokedBy;
        bool exists;
    }

    mapping(bytes32 => Product) public products;
    mapping(bytes32 => mapping(address => MintDelegateData)) public delegates;
    mapping(bytes32 => mapping(address => EntitlementData)) public entitlements;

    bool private initialized;

    modifier onlyPlatform() {
        require(msg.sender == platformAuthority, "Not platform authority");
        _;
    }

    modifier onlyCreatorOrPlatform(bytes32 productId) {
        require(
            msg.sender == platformAuthority || msg.sender == products[productId].creator,
            "Not creator or platform"
        );
        _;
    }

    modifier onlyMinter(bytes32 productId) {
        require(
            msg.sender == platformAuthority
                || msg.sender == products[productId].creator
                || _isDelegateValid(productId, msg.sender),
            "Not authorized to mint"
        );
        _;
    }

    modifier productUsable(bytes32 productId) {
        require(products[productId].active, "Product not active");
        require(!products[productId].frozen, "Product frozen");
        require(!platformFrozen, "Platform frozen");
        _;
    }

    // Events
    event ProductRegistered(bytes32 indexed productId, address indexed creator, string name);
    event ProductUpdated(bytes32 indexed productId);
    event EntitlementMinted(bytes32 indexed productId, address indexed user, int64 expiresAt, uint8 source);
    event EntitlementExtended(bytes32 indexed productId, address indexed user, int64 newExpiresAt);
    event EntitlementRevoked(bytes32 indexed productId, address indexed user, address revokedBy);
    event DelegationGranted(bytes32 indexed productId, address indexed delegate, address grantedBy);
    event DelegationRevoked(bytes32 indexed productId, address indexed delegate);
    event PlatformAuthorityTransferred(address indexed oldAuthority, address indexed newAuthority);

    function initializePlatform() external {
        require(!initialized, "Already initialized");
        platformAuthority = msg.sender;
        initialized = true;
    }

    function transferPlatformAuthority(address newAuthority) external onlyPlatform {
        require(newAuthority != address(0), "Cannot transfer to zero address");
        address old = platformAuthority;
        platformAuthority = newAuthority;
        emit PlatformAuthorityTransferred(old, newAuthority);
    }

    function registerProduct(
        bytes32 productId,
        string calldata name,
        string calldata metadataUri,
        int64 defaultDuration
    ) external {
        require(!platformFrozen, "Platform frozen");
        require(!products[productId].exists, "Product already exists");
        require(bytes(name).length <= 64, "Name too long");
        require(bytes(metadataUri).length <= 200, "URI too long");

        products[productId] = Product({
            creator: msg.sender,
            productId: productId,
            name: name,
            metadataUri: metadataUri,
            createdAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp),
            active: true,
            frozen: false,
            entitlementCount: 0,
            delegateCount: 0,
            defaultDuration: defaultDuration,
            exists: true
        });

        productCount++;
        emit ProductRegistered(productId, msg.sender, name);
    }

    function updateProduct(
        bytes32 productId,
        string calldata name,
        string calldata metadataUri,
        int64 defaultDuration
    ) external onlyCreatorOrPlatform(productId) {
        require(!products[productId].frozen, "Product frozen");
        Product storage p = products[productId];
        if (bytes(name).length > 0) {
            require(bytes(name).length <= 64, "Name too long");
            p.name = name;
        }
        if (bytes(metadataUri).length > 0) {
            require(bytes(metadataUri).length <= 200, "URI too long");
            p.metadataUri = metadataUri;
        }
        p.defaultDuration = defaultDuration;
        p.updatedAt = uint64(block.timestamp);
        emit ProductUpdated(productId);
    }

    function deactivateProduct(bytes32 productId) external onlyCreatorOrPlatform(productId) {
        require(products[productId].exists, "Product does not exist");
        products[productId].active = false;
        products[productId].updatedAt = uint64(block.timestamp);
    }

    function reactivateProduct(bytes32 productId) external onlyCreatorOrPlatform(productId) {
        require(products[productId].exists, "Product does not exist");
        products[productId].active = true;
        products[productId].updatedAt = uint64(block.timestamp);
    }

    function freezeProduct(bytes32 productId) external onlyPlatform {
        require(products[productId].exists, "Product does not exist");
        products[productId].frozen = true;
        products[productId].updatedAt = uint64(block.timestamp);
    }

    function unfreezeProduct(bytes32 productId) external onlyPlatform {
        require(products[productId].exists, "Product does not exist");
        products[productId].frozen = false;
        products[productId].updatedAt = uint64(block.timestamp);
    }

    function grantDelegation(
        bytes32 productId,
        address delegate,
        int64 expiresAt,
        uint64 maxMints
    ) external onlyCreatorOrPlatform(productId) {
        require(products[productId].active, "Product not active");
        require(!products[productId].frozen, "Product frozen");
        require(delegate != products[productId].creator, "Cannot delegate to creator");

        delegates[productId][delegate] = MintDelegateData({
            productId: productId,
            delegate: delegate,
            grantedBy: msg.sender,
            grantedAt: uint64(block.timestamp),
            expiresAt: expiresAt,
            maxMints: maxMints,
            mintsUsed: 0,
            active: true,
            exists: true
        });

        products[productId].delegateCount++;
        emit DelegationGranted(productId, delegate, msg.sender);
    }

    function revokeDelegation(
        bytes32 productId,
        address delegate
    ) external onlyCreatorOrPlatform(productId) {
        delegates[productId][delegate].active = false;
        emit DelegationRevoked(productId, delegate);
    }

    function mintEntitlement(
        bytes32 productId,
        address user,
        int64 expiresAt,
        uint8 source,
        string calldata sourceId,
        bool autoRenew
    ) external onlyMinter(productId) productUsable(productId) {
        require(bytes(sourceId).length <= 128, "Source ID too long");
        _incrementDelegateMints(productId);

        EntitlementData storage e = entitlements[productId][user];

        if (!e.exists) {
            // New entitlement
            e.productId = productId;
            e.user = user;
            e.grantedAt = uint64(block.timestamp);
            e.expiresAt = expiresAt;
            e.autoRenew = autoRenew;
            e.source = source;
            e.sourceId = sourceId;
            e.active = true;
            e.exists = true;
            products[productId].entitlementCount++;
        } else if (e.active) {
            // Extend: take later date, lifetime (0) always wins
            if (expiresAt == 0 || (e.expiresAt != 0 && expiresAt > e.expiresAt)) {
                e.expiresAt = expiresAt;
            }
            e.autoRenew = autoRenew;
            e.source = source;
            e.sourceId = sourceId;
        } else {
            // Reactivate revoked
            e.active = true;
            e.expiresAt = expiresAt;
            e.autoRenew = autoRenew;
            e.source = source;
            e.sourceId = sourceId;
            e.revokedAt = 0;
            e.revokedBy = address(0);
        }

        emit EntitlementMinted(productId, user, expiresAt, source);
    }

    function extendEntitlement(
        bytes32 productId,
        address user,
        int64 newExpiresAt,
        uint8 source,
        string calldata sourceId
    ) external onlyMinter(productId) productUsable(productId) {
        EntitlementData storage e = entitlements[productId][user];
        require(e.active, "Entitlement not active");
        require(bytes(sourceId).length <= 128, "Source ID too long");

        if (newExpiresAt != 0 && e.expiresAt != 0 && newExpiresAt < e.expiresAt) {
            revert("Cannot shorten expiry");
        }

        if (newExpiresAt == 0) {
            e.expiresAt = 0;
        } else if (e.expiresAt != 0) {
            e.expiresAt = newExpiresAt > e.expiresAt ? newExpiresAt : e.expiresAt;
        }

        e.source = source;
        e.sourceId = sourceId;

        emit EntitlementExtended(productId, user, e.expiresAt);
    }

    function revokeEntitlement(
        bytes32 productId,
        address user
    ) external onlyCreatorOrPlatform(productId) {
        EntitlementData storage e = entitlements[productId][user];
        require(e.exists, "Entitlement does not exist");
        e.active = false;
        e.revokedAt = uint64(block.timestamp);
        e.revokedBy = msg.sender;
        emit EntitlementRevoked(productId, user, msg.sender);
    }

    // View functions
    function isEntitled(bytes32 productId, address user) external view returns (bool) {
        EntitlementData storage e = entitlements[productId][user];
        return e.active && (e.expiresAt == 0 || e.expiresAt > int64(int256(block.timestamp)));
    }

    function getEntitlement(bytes32 productId, address user)
        external view returns (EntitlementData memory)
    {
        return entitlements[productId][user];
    }

    function getProduct(bytes32 productId) external view returns (Product memory) {
        return products[productId];
    }

    // Internal
    function _isDelegateValid(bytes32 productId, address delegate) internal view returns (bool) {
        MintDelegateData storage d = delegates[productId][delegate];
        return d.active
            && d.exists
            && (d.expiresAt == 0 || d.expiresAt > int64(int256(block.timestamp)))
            && (d.maxMints == 0 || d.mintsUsed < d.maxMints);
    }

    function _incrementDelegateMints(bytes32 productId) internal {
        if (msg.sender != platformAuthority && msg.sender != products[productId].creator) {
            delegates[productId][msg.sender].mintsUsed++;
        }
    }
}
