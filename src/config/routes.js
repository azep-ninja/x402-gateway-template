// src/config/routes.js

// ============================================================
// Route configuration for x402 gateway
//
// CUSTOMIZATION GUIDE:
//   1. Define your routes in ROUTE_CONFIG (bottom of file)
//   2. Each route key becomes a URL prefix: /v1/{key}/*
//   3. Set pricing, backend URL, and API key env vars
//   4. Networks are auto-discovered from env vars — no code changes needed
//
// SUPPORTED NETWORKS:
//   EVM: Native Circle USDC with EIP-3009 (transferWithAuthorization)
//        Domain: name="USD Coin", version="2", decimals=6
//
//   SVM: Solana USDC (SPL Token) via x402 SVM facilitator
//        Uses TransferChecked with partial signing
//        Requires SOLANA_FACILITATOR_PRIVATE_KEY for gas
//
// IMPORTANT: Only Circle-issued USDC with EIP-3009 support is compatible.
//   Abstract uses USDC.e (Bridged USDC via Stargate), which is a Circle
//   FiatTokenProxy (FiatTokenV2) with full EIP-3009 support — verified on-chain.
//   Standard bridged USDC.e from other bridges may NOT support EIP-3009.
//
// To add a new EVM chain:
//   1. Add network config below with CAIP-2 ID and RPC env var
//   2. Register in ALL_NETWORKS
//   3. Add RPC URL to .env
//   4. Fund settlement wallet with gas on that chain
//   5. Add viem chain import in src/middleware/x402.js
//
// To add a new SVM chain:
//   1. Add network config with CAIP-2 ID (solana:<genesis-hash>)
//   2. Set vm: 'svm' and token config with SPL mint address
//   3. Add RPC URL to .env
//   4. Fund facilitator wallet with SOL for gas
// ============================================================

// ─── Token Configs ─────────────────────────────────────────
// All native Circle USDC contracts share the same EIP-712 domain:
//   name: "USD Coin"
//   version: "2"
//   decimals: 6

function usdc(address) {
  return {
    address,
    name: 'USD Coin',
    version: '2',
    decimals: 6,
  };
}

function usdcv2(address) {
  return {
    address,
    name: 'USDC',
    version: '2',
    decimals: 6,
  };
}

// ─── Credit System Defaults ────────────────────────────────
// Global defaults for the credit system. Each route can override
// any of these values. Set ENABLE_CREDIT_SYSTEM=true to activate.
//
// Credits compensate payers when their paid request settles
// on-chain but the backend returns an error. The payer can
// redeem credits on subsequent requests without paying again.
export const CREDIT_DEFAULTS = {
  creditOnStatusCodes: [500, 502, 503, 504],  // Backend errors that earn credits
  maxCreditsPerPayer: 10,                       // Max credits per payer per route
  creditTtl: 86400,                             // 24 hours in seconds
};

// ─── EVM Network Configs ───────────────────────────────────

// Base (Coinbase L2) — Recommended primary chain (lowest fees)
const BASE = {
  vm: 'evm',
  caip2: 'eip155:8453',
  chainId: 8453,
  rpcEnvVar: 'BASE_RPC_URL',
  token: usdc('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
};

// Ethereum Mainnet
const ETHEREUM = {
  vm: 'evm',
  caip2: 'eip155:1',
  chainId: 1,
  rpcEnvVar: 'ETHEREUM_RPC_URL',
  token: usdc('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
};

// Arbitrum One
const ARBITRUM = {
  vm: 'evm',
  caip2: 'eip155:42161',
  chainId: 42161,
  rpcEnvVar: 'ARBITRUM_RPC_URL',
  token: usdc('0xaf88d065e77c8cC2239327C5EDb3A432268e5831'),
};

// Optimism (OP Mainnet)
const OPTIMISM = {
  vm: 'evm',
  caip2: 'eip155:10',
  chainId: 10,
  rpcEnvVar: 'OPTIMISM_RPC_URL',
  token: usdc('0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'),
};

// Polygon PoS (native USDC, NOT USDC.e)
const POLYGON = {
  vm: 'evm',
  caip2: 'eip155:137',
  chainId: 137,
  rpcEnvVar: 'POLYGON_RPC_URL',
  token: usdc('0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'),
};

// Avalanche C-Chain (native USDC, NOT USDC.e)
const AVALANCHE = {
  vm: 'evm',
  caip2: 'eip155:43114',
  chainId: 43114,
  rpcEnvVar: 'AVALANCHE_RPC_URL',
  token: usdc('0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'),
};

// Unichain
const UNICHAIN = {
  vm: 'evm',
  caip2: 'eip155:130',
  chainId: 130,
  rpcEnvVar: 'UNICHAIN_RPC_URL',
  token: usdcv2('0x078D782b760474a361dDA0AF3839290b0EF57AD6'),
};

// Linea
const LINEA = {
  vm: 'evm',
  caip2: 'eip155:59144',
  chainId: 59144,
  rpcEnvVar: 'LINEA_RPC_URL',
  token: usdcv2('0x176211869cA2b568f2A7D4EE941E073a821EE1ff'),
};

// Sonic
const SONIC = {
  vm: 'evm',
  caip2: 'eip155:146',
  chainId: 146,
  rpcEnvVar: 'SONIC_RPC_URL',
  token: usdcv2('0x29219dd400f2Bf60E5a23d13Be72B486D4038894'),
};

// HyperEVM
const HYPEREVM = {
  vm: 'evm',
  caip2: 'eip155:999',
  chainId: 999,
  rpcEnvVar: 'HYPEREVM_RPC_URL',
  token: usdcv2('0xb88339CB7199b77E23DB6E890353E22632Ba630f'),
};

// Ink
const INK = {
  vm: 'evm',
  caip2: 'eip155:57073',
  chainId: 57073,
  rpcEnvVar: 'INK_RPC_URL',
  token: usdcv2('0x2D270e6886d130D724215A266106e6832161EAEd'),
};

// Monad
const MONAD = {
  vm: 'evm',
  caip2: 'eip155:143',
  chainId: 143,
  rpcEnvVar: 'MONAD_RPC_URL',
  token: usdcv2('0x754704Bc059F8C67012fEd69BC8a327a5aafb603')
};

// Abstract (ZK rollup, EVM-compatible)
// Uses USDC.e (Bridged USDC via Stargate) — a Circle FiatTokenProxy (FiatTokenV2)
// with full EIP-3009 (transferWithAuthorization) support, verified on-chain.
// EIP-712 domain: name="Bridged USDC (Stargate)", version="2", decimals=6
// Contract: https://abscan.org/address/0x84A71ccD554Cc1b02749b35d22F684CC8ec987e1
const ABSTRACT = {
  vm: 'evm',
  caip2: 'eip155:2741',
  chainId: 2741,
  rpcEnvVar: 'ABSTRACT_RPC_URL',
  token: {
    address: '0x84A71ccD554Cc1b02749b35d22F684CC8ec987e1',
    name: 'Bridged USDC (Stargate)',
    version: '2',
    decimals: 6,
  },
};

// ─── Facilitator-based Networks ────────────────────────────
// For chains where the stablecoin doesn't natively support EIP-3009,
// use an external facilitator service to verify + settle payments.

// MegaETH — USDM (MegaUSD) via Meridian facilitator
// WARNING: USDM uses 18 decimals (not 6 like USDC). Gateway auto-scales pricing.
// Meridian specifics:
//   - Uses x402 v1 with short network names (not CAIP-2)
//   - Funds go to their facilitator contract, not directly to payTo
//   - Your payTo wallet is configured in Meridian's org settings
//   - 1% fee on withdrawal from Meridian
const MEGAETH = {
  vm: 'evm',
  caip2: 'eip155:4326',
  chainId: 4326,
  rpcEnvVar: 'MEGAETH_RPC_URL',
  facilitator: {
    url: 'https://api.mrdn.finance/v1',
    apiKeyEnv: 'MERIDIAN_API_KEY',
    networkName: 'megaeth',              // Meridian uses short names, not CAIP-2
    facilitatorContract: '0x8E7769D440b3460b92159Dd9C6D17302b036e2d6',
    x402Version: 1,                      // Meridian uses v1
  },
  token: {
    address: '0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7',
    name: 'MegaUSD',
    version: '1',
    decimals: 18,           // ⚠️ USDM uses 18 decimals, NOT 6
  },
};

// ─── Solana Networks ───────────────────────────────────────
// Uses x402 SVM facilitator pattern: client partially signs,
// your facilitator wallet co-signs as feePayer and submits.
//
// USDC on Solana: 6 decimals, SPL Token program
// Mint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

const SOLANA_MAINNET = {
  vm: 'svm',
  caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  rpcEnvVar: 'SOLANA_RPC_URL',
  token: {
    address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    name: 'USDC',
    decimals: 6,
  },
};

// ─── Network Registry ──────────────────────────────────────
// Add or remove networks here. Only networks with a configured
// RPC URL in .env will be advertised to agents.
const ALL_NETWORKS = {
  'eip155:8453': BASE,
  'eip155:1': ETHEREUM,
  'eip155:42161': ARBITRUM,
  'eip155:10': OPTIMISM,
  'eip155:137': POLYGON,
  'eip155:43114': AVALANCHE,
  'eip155:130': UNICHAIN,
  'eip155:59144': LINEA,
  'eip155:4326': MEGAETH,
  'eip155:146': SONIC,
  'eip155:999': HYPEREVM,
  'eip155:57073': INK,
  'eip155:143': MONAD,
  'eip155:2741': ABSTRACT,
  'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': SOLANA_MAINNET,
};

// ─── Active Network Filter ────────────────────────────────
// Auto-filters to only networks with configured RPC URLs.
// SVM networks also require SOLANA_FACILITATOR_PRIVATE_KEY.
function getActiveNetworks() {
  const active = {};
  for (const [caip2, network] of Object.entries(ALL_NETWORKS)) {
    if (!process.env[network.rpcEnvVar]) continue;
    if (network.vm === 'svm' && !process.env.SOLANA_FACILITATOR_PRIVATE_KEY) continue;
    active[caip2] = network;
  }
  return active;
}

// Lazy getter — resolves after dotenv loads
let _cachedNetworks = null;
export const SUPPORTED_NETWORKS = new Proxy({}, {
  get(target, prop) {
    if (!_cachedNetworks) _cachedNetworks = getActiveNetworks();
    if (prop === Symbol.iterator || prop === 'length') return undefined;
    return _cachedNetworks[prop];
  },
  ownKeys() {
    if (!_cachedNetworks) _cachedNetworks = getActiveNetworks();
    return Object.keys(_cachedNetworks);
  },
  getOwnPropertyDescriptor(target, prop) {
    if (!_cachedNetworks) _cachedNetworks = getActiveNetworks();
    if (prop in _cachedNetworks) {
      return { configurable: true, enumerable: true, value: _cachedNetworks[prop] };
    }
    return undefined;
  },
});

// ============================================================
// ROUTE CONFIG — CUSTOMIZE THIS FOR YOUR API
// ============================================================
//
// Each key here becomes a paid route at /v1/{key}/*
//
// Required fields:
//   path             — Express route pattern
//   backendName      — Display name for health/discovery
//   backendUrl       — Use getter for lazy env resolution
//   backendApiKeyEnv — Env var name holding your backend API key
//   backendApiKeyHeader — Header name your backend expects
//   price            — Human-readable price string
//   priceAtomic      — Price in USDC atomic units (6 decimals)
//                       $0.01 = 10000, $0.05 = 50000, $0.10 = 100000, $1.00 = 1000000
//   payTo            — EVM address to receive payments
//   description      — Used in 402 response and agent discovery
//   mimeType         — Response content type
//
// Optional:
//   payToSol         — Solana address for SOL payments
//   bazaarSchema     — Input/output schemas for Bazaar discovery (see BAZAAR_SCHEMAS in x402.js)
//   creditOnStatusCodes — Backend status codes that earn a credit (default: [500,502,503,504])
//   maxCreditsPerPayer  — Max credits per payer per route (default: 10)
//   creditTtl           — Credit TTL in seconds (default: 86400 / 24 hours)

export const ROUTE_CONFIG = {
  // ── Example Route: "myapi" ─────────────────────────────
  // Access at: POST /v1/myapi/endpoint
  // Cost: $0.01 per request
  myapi: {
    path: '/v1/myapi/*',
    backendName: 'My API',
    get backendUrl() { return process.env.MY_BACKEND_URL || ''; },
    backendApiKeyEnv: 'MY_BACKEND_API_KEY',
    backendApiKeyHeader: 'x-api-key',
    get price() { return process.env.MY_PRICE || '$0.01'; },
    get priceAtomic() { return process.env.MY_PRICE_ATOMIC || '10000'; },
    get payTo() { return process.env.MY_PAY_TO_ADDRESS || process.env.PAY_TO_ADDRESS; },
    get payToSol() { return process.env.MY_PAY_TO_ADDRESS_SOL; },
    description: 'Your API description here. This appears in 402 responses and agent discovery.',
    mimeType: 'application/json',
    // Credit system overrides (optional — falls back to CREDIT_DEFAULTS)
    // creditOnStatusCodes: [500, 502, 503, 504],
    // maxCreditsPerPayer: 10,
    // creditTtl: 86400,
  },

  // ── Add more routes here ───────────────────────────────
  // premium: {
  //   path: '/v1/premium/*',
  //   backendName: 'Premium API',
  //   get backendUrl() { return process.env.PREMIUM_BACKEND_URL || ''; },
  //   backendApiKeyEnv: 'PREMIUM_BACKEND_API_KEY',
  //   backendApiKeyHeader: 'Authorization',
  //   get price() { return '$0.50'; },
  //   get priceAtomic() { return '500000'; },
  //   get payTo() { return process.env.PREMIUM_PAY_TO_ADDRESS || process.env.PAY_TO_ADDRESS; },
  //   get payToSol() { return process.env.PREMIUM_PAY_TO_ADDRESS_SOL; },
  //   description: 'Premium tier with higher rate limits and richer data',
  //   mimeType: 'application/json',
  //   Credit system overrides (optional — falls back to CREDIT_DEFAULTS)
  //   creditOnStatusCodes: [500, 502, 503, 504],
  //   maxCreditsPerPayer: 10,
  //   creditTtl: 86400,
  // },
};
