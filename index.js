// ─────────────────────────────────────────────────────────────
//  ReachArc — x402 Attention Server + Gemini Agent
//  Contract: 0x68F4A263d383B419DfdB9f993f84CEC2D613891A
//  Chain: Arc Testnet (5042002)
// ─────────────────────────────────────────────────────────────

require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors());
app.use(express.json());

// ── CONFIG ────────────────────────────────────────────────────
const provider = new ethers.JsonRpcProvider(process.env.ARC_RPC);
const usedPayments = new Set();

const CONTRACT_ABI = [
  "function registerCreator(uint256,string,string,string) external",
  "function placeBid(address,uint256,string,bool,bytes32) external",
  "function acceptBid(uint256,string) external",
  "function rejectBid(uint256) external",
  "function claimRefund(uint256) external",
  "function getCreator(address) view returns (uint256,bool,uint256,string,string,string,uint256)",
  "function getAllCreators() view returns (address[])",
  "function getCreatorBids(address) view returns (uint256[])",
  "function getBid(uint256) view returns (address,address,uint256,string,uint256,uint8,bool,string,bytes32)",
  "function getTopBid(address) view returns (uint256)",
  "function getActiveBidCount(address) view returns (uint256)",
  "event BidPlaced(uint256 indexed,address indexed,address indexed,uint256,bool)",
  "event BidAccepted(uint256 indexed,address indexed,uint256)",
];

const USDC_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];

const contract = new ethers.Contract(
  process.env.CONTRACT_ADDRESS,
  CONTRACT_ABI,
  provider
);

// Gemini setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const gemini = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

// ── HELPERS ───────────────────────────────────────────────────
const USDC_DECIMALS = 6;
const toUsdc = (n) => BigInt(Math.round(n * 10 ** USDC_DECIMALS));
const fromUsdc = (n) => (Number(n) / 10 ** USDC_DECIMALS).toFixed(2);

async function verifyPayment(txHash, expectedTo, expectedAmount) {
  if (usedPayments.has(txHash.toLowerCase()))
    return { valid: false, reason: "Payment already used" };

  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) return { valid: false, reason: "Transaction not found" };
  if (receipt.status !== 1) return { valid: false, reason: "Transaction failed" };

  const iface = new ethers.Interface(USDC_ABI);
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== process.env.USDC_ADDRESS.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (
        parsed?.name === 'Transfer' &&
        parsed.args[1].toLowerCase() === expectedTo.toLowerCase() &&
        parsed.args[2] >= expectedAmount
      ) {
        usedPayments.add(txHash.toLowerCase());
        return { valid: true };
      }
    } catch { continue; }
  }
  return { valid: false, reason: "No matching USDC transfer found" };
}

async function scoreWithGemini(message, creatorBio, creatorTags) {
  try {
    const prompt = `You are an AI inbox filter for a professional creator on ReachArc, an attention marketplace on Arc blockchain.

Creator profile:
- Bio: ${creatorBio}
- Tags/Interests: ${creatorTags}

Incoming bid message:
"${message}"

Score this message from 1-10 on:
1. Relevance to the creator's expertise (1-10)
2. Professionalism and seriousness (1-10)  
3. Spam risk - 10 means definitely not spam (1-10)

Respond ONLY with valid JSON, no markdown, no backticks:
{"relevance":7,"professionalism":8,"spamRisk":9,"overall":8,"reason":"Brief explanation","recommendation":"ACCEPT or REVIEW or REJECT"}`;

    const result = await gemini.generateContent(prompt);
    const text = result.response.text().trim();
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    return { relevance: 5, professionalism: 5, spamRisk: 5, overall: 5, reason: "Could not score", recommendation: "REVIEW" };
  }
}

// ── ROUTES ────────────────────────────────────────────────────

// Health
app.get('/', (req, res) => {
  res.json({
    name: "ReachArc x402 Server",
    tagline: "First x402 human attention marketplace on Arc L1",
    contract: process.env.CONTRACT_ADDRESS,
    chain: "Arc Testnet",
    chainId: parseInt(process.env.CHAIN_ID),
    usdc: process.env.USDC_ADDRESS,
    protocol: "x402",
    aiEngine: "Gemini 2.0 Flash",
    endpoints: {
      listCreators: "GET /creators",
      getCreator:   "GET /creator/:address",
      sendMessage:  "POST /message/:address",
      scoreMessage: "POST /score",
      agentBid:     "POST /agent/bid"
    }
  });
});

// List all creators from contract
app.get('/creators', async (req, res) => {
  try {
    const addresses = await contract.getAllCreators();
    const creators = await Promise.all(addresses.map(async (addr) => {
      const [minBid, exists, earned, name, bio, tags] = await contract.getCreator(addr);
      const topBid = await contract.getTopBid(addr);
      const activeBids = await contract.getActiveBidCount(addr);
      return {
        address: addr,
        name, bio, tags,
        minBidUSD: fromUsdc(minBid),
        totalEarnedUSD: fromUsdc(earned),
        topBidUSD: fromUsdc(topBid),
        activeBids: activeBids.toString(),
        endpoint: `/creator/${addr}`
      };
    }));
    res.json({ count: creators.length, creators });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── THE x402 ENDPOINT ─────────────────────────────────────────
app.get('/creator/:address', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    const [minBid, exists, earned, name, bio, tags] = await contract.getCreator(addr);

    if (!exists) {
      return res.status(404).json({ error: "Creator not registered on ReachArc contract" });
    }

    const paymentHeader = req.headers['x-payment-txhash'] || req.headers['x-payment'];

    // ── No payment → return 402 ──
    if (!paymentHeader) {
      return res.status(402).json({
        x402Version: 1,
        error: "Payment Required",
        accepts: [{
          scheme: "exact",
          network: `eip155:${process.env.CHAIN_ID}`,
          maxAmountRequired: minBid.toString(),
          resource: `${req.protocol}://${req.get('host')}/creator/${req.params.address}`,
          description: `Pay ${fromUsdc(minBid)} USDC to reach ${name} on Arc`,
          mimeType: "application/json",
          payTo: addr,
          maxTimeoutSeconds: 300,
          asset: process.env.USDC_ADDRESS,
          extra: { name: "USD Coin", decimals: 6 }
        }],
        arc: {
          chainId: parseInt(process.env.CHAIN_ID),
          rpc: process.env.ARC_RPC,
          explorer: "https://testnet.arcscan.app",
          contract: process.env.CONTRACT_ADDRESS,
          note: "Arc uses USDC as native gas — no ETH needed"
        },
        creator: { name, bio, tags: tags.split(','), minBidUSD: fromUsdc(minBid) }
      });
    }

    // ── Payment header present → verify ──
    const verification = await verifyPayment(
      paymentHeader,
      addr,
      BigInt(minBid.toString())
    );

    if (!verification.valid) {
      return res.status(402).json({
        x402Version: 1,
        error: "Payment verification failed",
        reason: verification.reason
      });
    }

    res.json({
      success: true,
      x402: "payment_verified",
      creator: { address: addr, name, bio, tags: tags.split(','), minBidUSD: fromUsdc(minBid) },
      access: {
        messageEndpoint: `POST /message/${req.params.address}`,
        txHash: paymentHeader,
        instructions: "Include txHash + your message in the POST body"
      }
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SEND MESSAGE after x402 payment ───────────────────────────
app.post('/message/:address', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    const { message, senderAddress, txHash } = req.body;

    if (!txHash || !message)
      return res.status(400).json({ error: "txHash and message required" });

    if (!usedPayments.has(txHash.toLowerCase()))
      return res.status(402).json({ error: "Pay at GET /creator/:address first" });

    const [,, , name, bio, tags] = await contract.getCreator(addr);
    const score = await scoreWithGemini(message, bio, tags);

    console.log(`\n📨 Paid message delivered to ${name}`);
    console.log(`   From: ${senderAddress || 'Agent'}`);
    console.log(`   Score: ${score.overall}/10 — ${score.recommendation}`);

    res.json({
      success: true,
      delivered: true,
      creator: name,
      geminiScore: score,
      txHash,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SCORE A MESSAGE with Gemini ────────────────────────────────
app.post('/score', async (req, res) => {
  try {
    const { message, creatorAddress } = req.body;
    const [,,,, bio, tags] = await contract.getCreator(creatorAddress);
    const score = await scoreWithGemini(message, bio, tags);
    res.json({ score });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AUTONOMOUS AGENT BID ENDPOINT ──────────────────────────────
// Used by the bidder agent to record a bid after x402 payment
app.post('/agent/bid', async (req, res) => {
  try {
    const { creatorAddress, amount, message, txHash, isPrivate } = req.body;

    if (!usedPayments.has(txHash?.toLowerCase()))
      return res.status(402).json({ error: "Valid x402 payment required first" });

    res.json({
      success: true,
      recorded: true,
      creatorAddress,
      amountUSD: fromUsdc(amount),
      txHash,
      nextStep: `Call placeBid() on contract ${process.env.CONTRACT_ADDRESS} with x402TxHash`,
      contractEndpoint: "https://testnet.arcscan.app/address/" + process.env.CONTRACT_ADDRESS,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── VOICE PARSE ENDPOINT ──────────────────────────────────────
app.post('/voice-parse', async (req, res) => {
  const { transcript } = req.body;
  if (!transcript) return res.status(400).json({ error: 'No transcript' });

  try {
    const prompt = `You are a voice command parser for ReachArc, an agentic attention marketplace on Arc blockchain.

The user said: "${transcript}"

Parse this into a structured command. Possible actions:
- LAUNCH_AGENT: user wants to find creators and bid on them
- DISCOVER_CREATORS: user wants to browse creators
- REGISTER_CREATOR: user wants to register as a creator

Extract budget, maxPerBid, goal from their words.

Respond ONLY with valid JSON, no markdown:
{"action":"LAUNCH_AGENT","goal":"find web3 developers on Arc","budget":20,"maxPerBid":5,"minScore":6,"confidence":"high"}`;

    const result = await gemini.generateContent(prompt);
    const text = result.response.text().trim().replace(/\`\`\`json|\`\`\`/g, '').trim();
    const intent = JSON.parse(text);
    res.json({ intent });
  } catch (e) {
    res.json({
      intent: {
        action: 'LAUNCH_AGENT',
        goal: transcript,
        budget: 20,
        maxPerBid: 5,
        minScore: 6,
        confidence: 'low'
      }
    });
  }
});
// ── START ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   ReachArc x402 Server — Live on Arc Testnet    ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`\n  Server:   http://localhost:${PORT}`);
  console.log(`  Contract: ${process.env.CONTRACT_ADDRESS}`);
  console.log(`  Chain:    Arc Testnet (${process.env.CHAIN_ID})`);
  console.log(`  AI:       Gemini 2.0 Flash`);
  console.log('\n  Waiting for agents...\n');
});
