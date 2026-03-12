// src/middleware/x402.js

import {
  createPublicClient,
  createWalletClient,
  http,
  verifyTypedData,
  parseSignature,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  arbitrum,
  avalanche,
  base,
  hyperEvm,
  ink,
  linea,
  mainnet,
  megaeth,
  monad,
  optimism,
  polygon,
  sonic,
  unichain,
} from 'viem/chains';
import { ROUTE_CONFIG, SUPPORTED_NETWORKS, CREDIT_DEFAULTS } from '../config/routes.js';
import {
  getNonce,
  setNoncePending,
  setNonceConfirmed,
  deleteNonce,
  getIdempotencyCache,
  setIdempotencyCache,
  getCreditCount,
  decrementCredit,
  incrementCredit,
} from '../utils/redis.js';

// ─── SVM Imports ───────────────────────────────────────────
import { toFacilitatorSvmSigner } from '@x402/svm';
import { ExactSvmScheme } from '@x402/svm/exact/facilitator';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import { base58 } from '@scure/base';

// ============================================================
// EIP-3009 transferWithAuthorization ABI (EVM only)
// ============================================================
const ERC3009_ABI = parseAbi([
  'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function balanceOf(address account) view returns (uint256)',
]);

// ============================================================
// EIP-712 types for TransferWithAuthorization (EVM only)
// ============================================================
const EIP712_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

// ============================================================
// Viem chain configs (EVM only)
// Add new chains here when adding EVM network support
// ============================================================
const VIEM_CHAINS = {
  1: mainnet,
  8453: base,
  42161: arbitrum,
  10: optimism,
  137: polygon,
  43114: avalanche,
  59144: linea,
  130: unichain,
  4326: megaeth,
  146: sonic,
  999: hyperEvm,
  57073: ink,
  143: monad,
  // Abstract (Chain ID 2741) uses getViemChain() fallback — no named export needed.
  // Add more: import from viem/chains and register here
};

function getViemChain(network) {
  const known = VIEM_CHAINS[network.chainId];
  if (known) return known;

  // Fallback for unknown chains — provide minimal config
  return {
    id: network.chainId,
    name: `Chain ${network.chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: {
      default: { http: [process.env[network.rpcEnvVar]] },
    },
  };
}

// ============================================================
// Cache public clients per chain (EVM only)
// ============================================================
const publicClientCache = new Map();

function getPublicClient(network) {
  const cacheKey = network.chainId;
  if (publicClientCache.has(cacheKey)) {
    return publicClientCache.get(cacheKey);
  }

  const rpcUrl = process.env[network.rpcEnvVar];
  if (!rpcUrl) return null;

  const chain = getViemChain(network);
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  publicClientCache.set(cacheKey, client);
  return client;
}

// ============================================================
// SVM Facilitator — lazy singleton
// ============================================================
let _svmFacilitator = null;
let _svmFacilitatorAddress = null;
let _svmInitPromise = null;

async function getSvmFacilitator() {
  if (_svmFacilitator) {
    return { facilitator: _svmFacilitator, feePayerAddress: _svmFacilitatorAddress };
  }
  if (_svmInitPromise) return _svmInitPromise;

  _svmInitPromise = (async () => {
    const privKeyBase58 = process.env.SOLANA_FACILITATOR_PRIVATE_KEY;
    if (!privKeyBase58) {
      throw new Error('SOLANA_FACILITATOR_PRIVATE_KEY not configured');
    }

    const privKeyBytes = base58.decode(privKeyBase58);
    const keypairSigner = await createKeyPairSignerFromBytes(privKeyBytes);

    const rpcConfig = { defaultRpcUrl: process.env.SOLANA_RPC_URL };
    const facilitatorSigner = toFacilitatorSvmSigner(keypairSigner, rpcConfig);
    const facilitator = new ExactSvmScheme(facilitatorSigner);

    const addresses = facilitatorSigner.getAddresses();
    const feePayerAddress = addresses[0]?.toString();
    if (!feePayerAddress) {
      throw new Error('Failed to derive fee payer address from SOLANA_FACILITATOR_PRIVATE_KEY');
    }

    console.log(`[x402] SVM facilitator initialized | feePayer: ${feePayerAddress}`);

    _svmFacilitator = facilitator;
    _svmFacilitatorAddress = feePayerAddress;
    _svmInitPromise = null;
    return { facilitator, feePayerAddress };
  })();

  return _svmInitPromise;
}

// ============================================================
// Helpers
// ============================================================
function isSvmNetwork(network) {
  return network.vm === 'svm';
}

async function checkBalance(network, from, requiredAmount) {
  const client = getPublicClient(network);
  if (!client) {
    console.warn(`[x402] No public client for chain ${network.chainId}, skipping balance check`);
    return { sufficient: true };
  }

  try {
    const balance = await client.readContract({
      address: network.token.address,
      abi: ERC3009_ABI,
      functionName: 'balanceOf',
      args: [from],
    });

    if (balance < requiredAmount) {
      return { sufficient: false, balance: balance.toString(), required: requiredAmount.toString() };
    }
    return { sufficient: true, balance: balance.toString() };
  } catch (err) {
    console.warn(`[x402] Balance check failed (non-critical): ${err.message}`);
    return { sufficient: true };
  }
}

function extractPaymentIdentifier(paymentPayload) {
  try {
    const extensions = paymentPayload.extensions || paymentPayload.payload?.extensions;
    if (!extensions) return null;
    const idExt = extensions['payment-identifier'];
    if (idExt?.paymentId && typeof idExt.paymentId === 'string') {
      const id = idExt.paymentId;
      if (id.length >= 16 && id.length <= 128 && /^[a-zA-Z0-9_-]+$/.test(id)) {
        return id;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================
// EVM: Verify payment (local, no facilitator)
// ============================================================
async function verifyPaymentEvm(paymentPayload, routeConfig) {
  const { authorization, signature } = paymentPayload.payload;
  const network = SUPPORTED_NETWORKS[paymentPayload.network];

  if (!network) return { valid: false, reason: `Unsupported network: ${paymentPayload.network}` };
  if (paymentPayload.scheme !== 'exact') return { valid: false, reason: `Unsupported scheme: ${paymentPayload.scheme}` };

  // Check amount
  const basePriceAtomic = BigInt(routeConfig.priceAtomic);
  const decimalDiff = network.token.decimals - 6;
  const requiredAmount = decimalDiff > 0 ? basePriceAtomic * (10n ** BigInt(decimalDiff)) : basePriceAtomic;
  if (BigInt(authorization.value) < requiredAmount) {
    return { valid: false, reason: `Insufficient payment: got ${authorization.value}, need ${requiredAmount}` };
  }

  // Check recipient
  const payTo = routeConfig.payTo?.toLowerCase();
  if (!payTo) return { valid: false, reason: 'No payTo address configured' };
  if (authorization.to.toLowerCase() !== payTo) return { valid: false, reason: `Wrong recipient: expected ${payTo}` };

  // Check validity window
  const now = Math.floor(Date.now() / 1000);
  if (now < Number(authorization.validAfter)) return { valid: false, reason: 'Payment not yet valid' };
  if (now > Number(authorization.validBefore)) return { valid: false, reason: 'Payment expired' };

  // Check replay via Redis
  const existing = await getNonce(authorization.nonce);
  if (existing) return { valid: false, reason: `Nonce already used (${existing.status || 'unknown'})` };

  // Verify EIP-712 signature
  const domain = {
    name: network.token.name,
    version: network.token.version,
    chainId: network.chainId,
    verifyingContract: network.token.address,
  };
  const message = {
    from: authorization.from,
    to: authorization.to,
    value: BigInt(authorization.value),
    validAfter: BigInt(authorization.validAfter),
    validBefore: BigInt(authorization.validBefore),
    nonce: authorization.nonce,
  };

  try {
    const isValid = await verifyTypedData({
      address: authorization.from,
      domain, types: EIP712_TYPES,
      primaryType: 'TransferWithAuthorization',
      message, signature,
    });
    if (!isValid) return { valid: false, reason: 'Signature does not match sender' };
  } catch (err) {
    return { valid: false, reason: `Signature verification failed: ${err.message}` };
  }

  // Balance check
  const balanceCheck = await checkBalance(network, authorization.from, requiredAmount);
  if (!balanceCheck.sufficient) {
    return { valid: false, reason: `Insufficient balance: has ${balanceCheck.balance}, needs ${balanceCheck.required}` };
  }

  return { valid: true };
}

// ============================================================
// EVM: Settle payment on-chain
// ============================================================
async function settlePaymentEvm(paymentPayload) {
  const { authorization, signature } = paymentPayload.payload;
  const network = SUPPORTED_NETWORKS[paymentPayload.network];
  const rpcUrl = process.env[network.rpcEnvVar];

  if (!rpcUrl) throw new Error(`No RPC URL for ${paymentPayload.network} (env: ${network.rpcEnvVar})`);

  const chain = getViemChain(network);
  const account = privateKeyToAccount(process.env.SETTLEMENT_PRIVATE_KEY);

  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  const { v, r, s } = parseSignature(signature);

  const txHash = await walletClient.writeContract({
    address: network.token.address,
    abi: ERC3009_ABI,
    functionName: 'transferWithAuthorization',
    args: [
      authorization.from, authorization.to,
      BigInt(authorization.value),
      BigInt(authorization.validAfter), BigInt(authorization.validBefore),
      authorization.nonce, Number(v), r, s,
    ],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
  console.log(`[x402] EVM settled: ${txHash} | block ${receipt.blockNumber} | payer ${authorization.from}`);

  return { txHash, network: paymentPayload.network, blockNumber: Number(receipt.blockNumber) };
}

// ============================================================
// SVM: Verify payment via @x402/svm facilitator
// ============================================================
async function verifyPaymentSvm(paymentPayload, routeConfig, network) {
  const { facilitator, feePayerAddress } = await getSvmFacilitator();

  const payTo = routeConfig.payToSol;
  if (!payTo) return { valid: false, reason: 'No Solana payTo address configured' };

  const basePriceAtomic = BigInt(routeConfig.priceAtomic);
  const decimalDiff = network.token.decimals - 6;
  const amountRequired = decimalDiff > 0
    ? (basePriceAtomic * (10n ** BigInt(decimalDiff))).toString()
    : basePriceAtomic.toString();

  const svmPayload = {
    payload: paymentPayload.payload,
    accepted: { scheme: 'exact', network: paymentPayload.network },
  };
  const svmRequirements = {
    scheme: 'exact', network: paymentPayload.network,
    amount: amountRequired, asset: network.token.address,
    payTo, extra: { feePayer: feePayerAddress },
  };

  try {
    const result = await facilitator.verify(svmPayload, svmRequirements);
    if (!result.isValid) {
      return { valid: false, reason: `SVM verification failed: ${result.invalidReason || 'unknown'}` };
    }
    return { valid: true, payer: result.payer };
  } catch (err) {
    return { valid: false, reason: `SVM verification error: ${err.message}` };
  }
}

// ============================================================
// SVM: Settle payment via @x402/svm facilitator
// ============================================================
async function settlePaymentSvm(paymentPayload, routeConfig, network) {
  const { facilitator, feePayerAddress } = await getSvmFacilitator();

  const payTo = routeConfig.payToSol;
  if (!payTo) throw new Error('No Solana payTo address configured');

  const basePriceAtomic = BigInt(routeConfig.priceAtomic);
  const decimalDiff = network.token.decimals - 6;
  const amountRequired = decimalDiff > 0
    ? (basePriceAtomic * (10n ** BigInt(decimalDiff))).toString()
    : basePriceAtomic.toString();

  const svmPayload = {
    payload: paymentPayload.payload,
    accepted: { scheme: 'exact', network: paymentPayload.network },
  };
  const svmRequirements = {
    scheme: 'exact', network: paymentPayload.network,
    amount: amountRequired, asset: network.token.address,
    payTo, extra: { feePayer: feePayerAddress },
  };

  const result = await facilitator.settle(svmPayload, svmRequirements);
  if (!result.success) throw new Error(`SVM settlement failed: ${result.errorReason || 'unknown'}`);

  console.log(`[x402] SVM settled: ${result.transaction} | payer ${result.payer}`);
  return { txHash: result.transaction, network: result.network || paymentPayload.network, blockNumber: null, payer: result.payer };
}

// ============================================================
// Facilitator-based verify (EVM, external service)
// ============================================================
async function verifyPaymentViaFacilitator(paymentPayload, routeConfig, network) {
  const { url, apiKeyEnv, networkName, facilitatorContract, x402Version } = network.facilitator;
  // apiKeyEnv is optional — public facilitators (e.g. Abstract) require no auth.
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : null;
  if (apiKeyEnv && !apiKey) return { valid: false, reason: `No API key for facilitator (env: ${apiKeyEnv})` };

  const basePriceAtomic = BigInt(routeConfig.priceAtomic);
  const decimalDiff = network.token.decimals - 6;
  const amountRequired = decimalDiff > 0
    ? (basePriceAtomic * (10n ** BigInt(decimalDiff))).toString()
    : basePriceAtomic.toString();

  const facilitatorNetwork = networkName || paymentPayload.network;
  const facilitatorPayTo = facilitatorContract || routeConfig.payTo;

  const body = {
    paymentPayload: {
      x402Version: x402Version || paymentPayload.x402Version || 2,
      scheme: paymentPayload.scheme,
      network: facilitatorNetwork,
      payload: paymentPayload.payload,
    },
    paymentRequirements: {
      scheme: 'exact', network: facilitatorNetwork,
      maxAmountRequired: amountRequired, maxTimeoutSeconds: 3600,
      payTo: facilitatorPayTo, asset: network.token.address,
      resource: routeConfig.resource || '', description: routeConfig.description,
      mimeType: routeConfig.mimeType, amount: amountRequired, recipient: facilitatorPayTo,
    },
  };

  try {
    console.log(`[x402] Facilitator verify: ${url}/verify | network: ${facilitatorNetwork}`);
    const res = await fetch(`${url}/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });

    const resText = await res.text();
    let data;
    try { data = JSON.parse(resText); } catch {
      return { valid: false, reason: `Facilitator returned non-JSON (${res.status})` };
    }

    if (!res.ok) return { valid: false, reason: `Facilitator error (${res.status}): ${data.error?.message || data.invalidReason || JSON.stringify(data)}` };
    if (data.isValid) return { valid: true, payer: data.payer };
    return { valid: false, reason: data.invalidReason || 'Facilitator rejected payment' };
  } catch (err) {
    return { valid: false, reason: `Facilitator verify failed: ${err.message}` };
  }
}

// ============================================================
// Facilitator-based settle (EVM, external service)
// ============================================================
async function settlePaymentViaFacilitator(paymentPayload, routeConfig, network) {
  const { url, apiKeyEnv, networkName, facilitatorContract, x402Version } = network.facilitator;
  // apiKeyEnv is optional — public facilitators (e.g. Abstract) require no auth.
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : null;

  const basePriceAtomic = BigInt(routeConfig.priceAtomic);
  const decimalDiff = network.token.decimals - 6;
  const amountRequired = decimalDiff > 0
    ? (basePriceAtomic * (10n ** BigInt(decimalDiff))).toString()
    : basePriceAtomic.toString();

  const facilitatorNetwork = networkName || paymentPayload.network;
  const facilitatorPayTo = facilitatorContract || routeConfig.payTo;

  const body = {
    paymentPayload: {
      x402Version: x402Version || paymentPayload.x402Version || 2,
      scheme: paymentPayload.scheme,
      network: facilitatorNetwork,
      payload: paymentPayload.payload,
    },
    paymentRequirements: {
      scheme: 'exact', network: facilitatorNetwork,
      maxAmountRequired: amountRequired, maxTimeoutSeconds: 3600,
      payTo: facilitatorPayTo, asset: network.token.address,
      resource: routeConfig.resource || '', description: routeConfig.description,
      mimeType: routeConfig.mimeType, amount: amountRequired, recipient: facilitatorPayTo,
    },
  };

  console.log(`[x402] Facilitator settle: ${url}/settle | network: ${facilitatorNetwork}`);
  const res = await fetch(`${url}/settle`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok || !data.success) {
    throw new Error(`Facilitator settle failed: ${data.errorReason || data.error?.message || JSON.stringify(data)}`);
  }

  console.log(`[x402] Settled via facilitator: ${data.transaction} | network ${data.network}`);
  return { txHash: data.transaction, network: data.network || paymentPayload.network, blockNumber: null, facilitator: url };
}

// ============================================================
// Build 402 Payment Required response
// ============================================================
async function buildPaymentRequired(routeConfig, req, routeKey) {
  const resource = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const basePriceAtomic = BigInt(routeConfig.priceAtomic);

  // Get SVM fee payer if any SVM networks are active
  let svmFeePayerAddress = null;
  const hasSvmNetworks = Object.values(SUPPORTED_NETWORKS).some(n => n.vm === 'svm');
  if (hasSvmNetworks) {
    try {
      const { feePayerAddress } = await getSvmFacilitator();
      svmFeePayerAddress = feePayerAddress;
    } catch (err) {
      console.warn(`[x402] Could not init SVM facilitator for 402 response: ${err.message}`);
    }
  }

  const accepts = [];

  for (const network of Object.values(SUPPORTED_NETWORKS)) {
    const decimalDiff = network.token.decimals - 6;
    const amountRequired = decimalDiff > 0
      ? (basePriceAtomic * (10n ** BigInt(decimalDiff))).toString()
      : basePriceAtomic.toString();

    if (isSvmNetwork(network)) {
      const payTo = routeConfig.payToSol;
      if (!payTo || !svmFeePayerAddress) continue;

      accepts.push({
        scheme: 'exact', network: network.caip2,
        maxAmountRequired: amountRequired, amount: amountRequired,
        maxTimeoutSeconds: 3600, resource,
        description: routeConfig.description, mimeType: routeConfig.mimeType,
        payTo, asset: network.token.address,
        extra: { feePayer: svmFeePayerAddress },
      });
    } else {
      const effectivePayTo = network.facilitator?.facilitatorContract || routeConfig.payTo;
      accepts.push({
        scheme: 'exact', network: network.caip2,
        maxAmountRequired: amountRequired, amount: amountRequired,
        maxTimeoutSeconds: 3600, resource,
        description: routeConfig.description, mimeType: routeConfig.mimeType,
        payTo: effectivePayTo, asset: network.token.address,
        extra: { name: network.token.name, version: network.token.version },
      });
    }
  }

  const extensions = {
    'payment-identifier': { supported: true, required: false },
  };

  // Header payload: minimal per x402 v2 spec — full details live in the JSON body
  const headerAccepts = accepts.map(({ scheme, network, amount, payTo, maxTimeoutSeconds, asset, extra }) => ({
    scheme, network, amount, payTo, maxTimeoutSeconds, asset, extra,
  }));

  const headerPayload = {
    x402Version: 2,
    accepts: headerAccepts,
  };

  const headerBase64 = Buffer.from(JSON.stringify(headerPayload)).toString('base64');

  const strictAccepts = accepts.map(({ scheme, network, amount, payTo, maxTimeoutSeconds, asset, extra }) => ({
    scheme, network, amount, payTo, maxTimeoutSeconds, asset, extra,
  }));

  const body = {
    x402Version: 2, accepts: strictAccepts,
    resource: { url: resource, description: routeConfig.description, mimeType: routeConfig.mimeType },
    extensions,
  };

  return { headerBase64, body };
}

// ─── Credit System Helpers ──────────────────────────────────

function isCreditSystemEnabled() {
  return process.env.ENABLE_CREDIT_SYSTEM === 'true';
}

function getCreditConfig(routeConfig) {
  return {
    creditOnStatusCodes: routeConfig.creditOnStatusCodes || CREDIT_DEFAULTS.creditOnStatusCodes,
    maxCreditsPerPayer: routeConfig.maxCreditsPerPayer ?? CREDIT_DEFAULTS.maxCreditsPerPayer,
    creditTtl: routeConfig.creditTtl ?? CREDIT_DEFAULTS.creditTtl,
  };
}

// ============================================================
// Express middleware factory
// ============================================================
export function x402PaymentMiddleware(routeKey) {
  return async (req, res, next) => {
    const routeConfig = ROUTE_CONFIG[routeKey];
    if (!routeConfig) return res.status(500).json({ error: `Unknown route: ${routeKey}` });

    // Check for payment header
    const paymentHeader = req.headers['payment-signature'] || req.headers['x-payment'];

    if (!paymentHeader) {
      const { headerBase64, body } = await buildPaymentRequired(routeConfig, req, routeKey);
      res.set('PAYMENT-REQUIRED', headerBase64);
      return res.status(402).json({
        ...body,
        error: 'Payment required',
        message: `This endpoint requires ${routeConfig.price} USDC. See accepts array for supported networks.`,
      });
    }

    // Decode payment payload
    let paymentPayload;
    try {
      paymentPayload = JSON.parse(Buffer.from(paymentHeader, 'base64').toString());
    } catch {
      return res.status(400).json({ error: 'Invalid payment payload encoding' });
    }

    // Idempotency check
    const paymentId = extractPaymentIdentifier(paymentPayload);
    if (paymentId) {
      const cached = await getIdempotencyCache(paymentId);
      if (cached) {
        console.log(`[x402] Idempotency hit: ${paymentId.slice(0, 16)}...`);
        if (cached.response?.paymentResponseHeader) {
          res.set('PAYMENT-RESPONSE', cached.response.paymentResponseHeader);
        }
        return next();
      }
    }

    // Resolve network
    const network = SUPPORTED_NETWORKS[paymentPayload.network];
    if (!network) {
      return res.status(402).json({
        error: 'Unsupported network',
        reason: `Network ${paymentPayload.network} is not supported`,
      });
    }

    // Determine payment path
    const useSvm = isSvmNetwork(network);
    const useEvmFacilitator = !useSvm && !!network.facilitator;

    const enrichedRouteConfig = {
      ...routeConfig,
      resource: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
    };

    // Verify payment
    let verification;
    if (useSvm) {
      verification = await verifyPaymentSvm(paymentPayload, enrichedRouteConfig, network);
    } else if (useEvmFacilitator) {
      verification = await verifyPaymentViaFacilitator(paymentPayload, enrichedRouteConfig, network);
    } else {
      verification = await verifyPaymentEvm(paymentPayload, routeConfig);
    }

    if (!verification.valid) {
      const pathLabel = useSvm ? 'SVM' : useEvmFacilitator ? 'facilitator' : 'EVM';
      console.warn(`[x402] Verification failed (${pathLabel}): ${verification.reason}`);
      const { headerBase64, body } = await buildPaymentRequired(routeConfig, req, routeKey);
      res.set('PAYMENT-REQUIRED', headerBase64);
      return res.status(402).json({
        ...body, error: 'Payment verification failed', reason: verification.reason,
      });
    }

    // Extract payer address (verified via signature — cannot be spoofed)
    const payerAddress = verification.payer
      || paymentPayload.payload?.authorization?.from
      || 'unknown';

    // ── Credit check — consume credit if available ───────────
    let creditConsumed = false;

    if (isCreditSystemEnabled() && payerAddress !== 'unknown') {
      const creditConfig = getCreditConfig(routeConfig);

      if (creditConfig.creditOnStatusCodes.length > 0) {
        const creditCount = await getCreditCount(payerAddress, routeKey);

        if (creditCount > 0) {
          creditConsumed = await decrementCredit(payerAddress, routeKey);
          if (creditConsumed) {
            console.log(`[x402] Credit consumed: ${payerAddress.slice(0, 10)}... | route: ${routeKey} | remaining: ${creditCount - 1}`);
          }
        }
      }
    }

    // ── Settlement (skip if credit was consumed) ─────────────
    let didSettle = false;

    if (!creditConsumed) {
      // Mark nonce as pending
      let nonceKey = null;
      if (useSvm) {
        const txData = paymentPayload.payload?.transaction;
        if (txData) {
          const crypto = await import('crypto');
          nonceKey = 'svm:' + crypto.createHash('sha256').update(txData).digest('hex');
        }
      } else if (!useEvmFacilitator) {
        nonceKey = paymentPayload.payload?.authorization?.nonce;
      }

      if (nonceKey) {
        const acquired = await setNoncePending(nonceKey, {
          network: paymentPayload.network,
          payer: payerAddress,
          route: routeKey, vm: useSvm ? 'svm' : 'evm',
        });
        if (!acquired) {
          return res.status(402).json({
            error: 'Payment verification failed',
            reason: 'Nonce already used or settlement in progress',
          });
        }
      }

      // Settle payment on-chain
      try {
        let settlement;
        if (useSvm) {
          settlement = await settlePaymentSvm(paymentPayload, enrichedRouteConfig, network);
        } else if (useEvmFacilitator) {
          settlement = await settlePaymentViaFacilitator(paymentPayload, enrichedRouteConfig, network);
        } else {
          settlement = await settlePaymentEvm(paymentPayload);
        }

        // Confirm nonce
        if (nonceKey) {
          await setNonceConfirmed(nonceKey, {
            txHash: settlement.txHash, network: settlement.network,
            blockNumber: settlement.blockNumber,
            payer: settlement.payer || payerAddress,
            route: routeKey, vm: useSvm ? 'svm' : 'evm',
          });
        }

        const paymentResponseData = {
          success: true, txHash: settlement.txHash,
          network: settlement.network, blockNumber: settlement.blockNumber,
          ...(settlement.facilitator && { facilitator: settlement.facilitator }),
        };

        const paymentResponseHeader = Buffer.from(JSON.stringify(paymentResponseData)).toString('base64');
        res.set('PAYMENT-RESPONSE', paymentResponseHeader);

        // Cache for idempotency
        if (paymentId) {
          await setIdempotencyCache(paymentId, { paymentResponseHeader, settlement: paymentResponseData });
        }

        didSettle = true;
      } catch (err) {
        if (nonceKey) await deleteNonce(nonceKey);
        console.error(`[x402] Settlement failed:`, err.message);
        return res.status(402).json({ error: 'Payment settlement failed', reason: err.message });
      }
    } else {
      // Credit was consumed — set header indicating credit usage
      res.set('X-x402-Credit', 'consumed');
    }

    // ── Async credit issuance on response finish ─────────────
    if (didSettle && isCreditSystemEnabled() && payerAddress !== 'unknown') {
      const creditConfig = getCreditConfig(routeConfig);

      if (creditConfig.creditOnStatusCodes.length > 0) {
        res.on('finish', () => {
          const statusCode = res.statusCode;

          if (creditConfig.creditOnStatusCodes.includes(statusCode)) {
            incrementCredit(
              payerAddress,
              routeKey,
              creditConfig.maxCreditsPerPayer,
              creditConfig.creditTtl
            ).then(newCount => {
              if (newCount >= 0) {
                console.log(`[x402] Credit issued: ${payerAddress.slice(0, 10)}... | route: ${routeKey} | reason: backend ${statusCode} | total: ${newCount}`);
                if (newCount >= creditConfig.maxCreditsPerPayer) {
                  console.warn(`[x402] Credit cap reached: ${payerAddress.slice(0, 10)}... | route: ${routeKey} | cap: ${creditConfig.maxCreditsPerPayer} — backend may be degraded`);
                }
              }
            }).catch(err => {
              console.error(`[x402] Credit issuance failed (non-critical): ${err.message}`);
            });
          }
        });
      }
    }

    next();
  };
}