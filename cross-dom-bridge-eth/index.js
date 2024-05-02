#! /usr/local/bin/node

// Transfers between L1 and L2 using the Thanos SDK

const ethers = require("ethers")
const thanosSDK = require("@tokamak-network/thanos-sdk")
const coreUtils = require('@tokamak-network/core-utils')
require('dotenv').config()
const fs = require("fs");

const l1Rpc = process.env.L1_RPC
const l2Rpc = process.env.L2_RPC
const privateKey = process.env.PRIVATE_KEY
const l1ChainId = process.env.L1_CHAIN_ID
const l2ChainId = process.env.L2_CHAIN_ID
const erc20ABI = JSON.parse(fs.readFileSync("erc20.json"));


const depositAmount = BigInt(1)
const withdrawAmount = BigInt(1)


// Global variable because we need them almost everywhere
let crossChainMessenger = null
let ethContractOnL2 = null

// Check if the private key has '0x' prefix
const addHexPrefix = (privateKey) => {
  if (privateKey.substring(0, 2) !== "0x") {
    privateKey = "0x" + privateKey
  }
  return privateKey
}

// Get the signers
const getSigners = async () => {
    const l1RpcProvider = new ethers.providers.JsonRpcProvider(l1Rpc)
    const l2RpcProvider = new ethers.providers.JsonRpcProvider(l2Rpc)
    const l1Wallet = new ethers.Wallet(addHexPrefix(privateKey), l1RpcProvider)
    const l2Wallet = new ethers.Wallet(addHexPrefix(privateKey), thanosSDK.asL2Provider(l2RpcProvider))

    return [l1Wallet, l2Wallet]
}


const setup = async() => {
  const [l1Signer, l2Signer] = await getSigners()
  console.log(`L1 address: ${l1Signer.address}`)
  crossChainMessenger = new thanosSDK.CrossChainMessenger({
      bedrock: true,
      l1ChainId: l1ChainId,
      l2ChainId: l2ChainId, 
      l1SignerOrProvider: l1Signer,
      l2SignerOrProvider: l2Signer,
  })

  ethContractOnL2 = new ethers.Contract(coreUtils.predeploys.ETH, erc20ABI, l2Signer)
}

const reportBalances = async () => {
  let l1ETHBalance = await l1Signer.getBalance()
  let l2ETHBalance = await ethContractOnL2.balanceOf(l2Signer.address)
  console.log(`ETH Token on L1:${l1ETHBalance} \n
              ETH Token on L2: ${l2ETHBalance}`);
};


const depositETH = async () => {
  console.log("Depositing ETH from Ethereum to Thanos")
  const start = new Date()

  const response = await crossChainMessenger.depositETH(depositAmount)
  console.log(`Deposit transaction hash on L1: ${response.hash}`)
  await response.wait()

  console.log("Waiting for status to change to RELAYED")
  await crossChainMessenger.waitForMessageStatus(response, thanosSDK.MessageStatus.RELAYED)

  console.log(`Deposit ETH took ${(new Date()-start)/1000} seconds\n\n`)
}

const withdrawETH = async () => {
  console.log("Withdrawing ETH from Thanos to Ethereum")

  await reportBalances()

  const response = await crossChainMessenger.withdrawETH(withdrawAmount)
  console.log(`Withdrawal transaction hash (on L2): ${response.hash}`)
  const withdrawalTx = await response.wait()

  console.log("In the challenge period, waiting for status READY_TO_PROVE")

  await crossChainMessenger.waitForMessageStatus(response, thanosSDK.MessageStatus.READY_TO_PROVE)

  console.log('Prove the message')
  const proveTx = await crossChainMessenger.proveMessage(withdrawalTx)
  const proveReceipt = await proveTx.wait(3)
  console.log('Proved transaction hash (on L1):', proveReceipt.transactionHash)

  const finalizeInterval = setInterval(async () => {
    const currentStatus = await crossChainMessenger.getMessageStatus(withdrawalTx)
    console.log('Message status:', currentStatus)
  }, 3000)

  try {
    await crossChainMessenger.waitForMessageStatus(
      withdrawalTx,
      thanosSDK.MessageStatus.READY_FOR_RELAY
    )
  } finally {
    clearInterval(finalizeInterval)
  }

  console.log("Ready for relay, finalizing message now")

  await crossChainMessenger.finalizeMessage(withdrawalTx)

  console.log("Waiting for status to change to RELAYED")
  await crossChainMessenger.waitForMessageStatus(response,
    thanosSDK.MessageStatus.RELAYED)

  console.log(`Withdraw ETH took ${(new Date()-start)/1000} seconds\n\n\n`)
}

const main = async () => {
    await setup()
    await depositETH()
    await withdrawETH()
}

main().then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })