#! /usr/local/bin/node
require("dotenv").config();
const ethers = require("ethers");
const thanosSDK = require("@tokamak-network/thanos-sdk");
const fs = require("fs");

const erc20ABI = JSON.parse(fs.readFileSync("erc20.json"));


const privateKey = process.env.PRIVATE_KEY
const l1ChainId = process.env.L1_CHAIN_ID
const l2ChainId = process.env.L2_CHAIN_ID


const l1RpcProvider = new ethers.providers.JsonRpcProvider(process.env.L1_RPC);
const l2RpcProvider = new ethers.providers.JsonRpcProvider(process.env.L2_RPC)
const l1Wallet = new ethers.Wallet(privateKey, l1RpcProvider);
const l2Wallet = new ethers.Wallet(privateKey, thanosSDK.asL2Provider(l2RpcProvider));

// Global
var optimismPortal
var l2NativeTokenContractInL1
var walletAddr

const depositAmount = BigInt(1)
const withdrawAmount = BigInt(1)

const setup = async () => {
  walletAddr = l1Wallet.getAddress()
  optimismPortal = new thanosSDK.Portals({
    l1ChainId,
    l2ChainId,
    l1SignerOrProvider: l1Wallet,
    l2SignerOrProvider: l2Wallet,
  })
  l2NativeTokenContractInL1 = new ethers.Contract(
    process.env.NATIVE_TOKEN,
    erc20ABI,
    l1Wallet
  )
}


const reportBalances = async () => {
  const l1Balance = (await l2NativeTokenContractInL1.balanceOf(walletAddr)).toString();
  const l2Balance = (await l2Wallet.getBalance())
  console.log(`Native Token on L1:${l1Balance}. Native Token on L2: ${l2Balance}`);
};

const deposit = async () => {
  await reportBalances()

  const start = new Date();

  // Need the l2 address to know which bridge is responsible
  const allowanceResponse = await l2NativeTokenContractInL1.approve(
    optimismPortal.contracts.l1.OptimismPortal.address,
    depositAmount
  );
  await allowanceResponse.wait();
  console.log(`Approval native token transaction hash (on L1): ${allowanceResponse.hash}`)

  const depositTx = await optimismPortal.depositTransaction({
    to: walletAddr,
    value: depositAmount,
    gasLimit: ethers.BigNumber.from('200000'),
    data: '0x',
  })
  const depositReceipt = await depositTx.wait()
  console.log(`Deposit transaction on L1: ${depositReceipt.transactionHash}`)

  const relayTxHash = await optimismPortal.waitingDepositTransactionRelayed(
    depositReceipt,
    {}
  )
  if (!relayTxHash) {
    throw new Error("Relay tx hash empty")
  }

  console.log(`Relayed transaction: ${relayTxHash}`)

  const relayedTxReceipt = await l2RpcProvider.getTransactionReceipt(relayTxHash)

  console.log(`Relayed transaction receipt on L2: ${relayedTxReceipt.transactionHash}`)

  await reportBalances()

  console.log(`Deposit via OptimsimPortal takes ${(new Date() - start) / 1000} seconds`)
}

const withdraw = async () => {
  const start = new Date()
  await reportBalances()
  const withdrawalTx = await optimismPortal.initiateWithdrawal({
    target: walletAddr,
    value: withdrawAmount,
    gasLimit: ethers.BigNumber.from('200000'),
    data: '0x'
  })

  const withdrawalReceipt = await withdrawalTx.wait()
  console.log(`Withdraw transaction on L2: ${withdrawalTx.hash}`)

  const withdrawalMessageInfo = await optimismPortal.calculateWithdrawalMessage(
    withdrawalReceipt
  )
  console.log(`Withdrawal info: ${JSON.stringify(withdrawalReceipt)}`)

  let status = await optimismPortal.getMessageStatus(withdrawalReceipt)
  console.log(`Withdaraw transaction status: ${thanosSDK.MessageStatus[status]}`)

  await optimismPortal.waitForWithdrawalTxReadyForRelay(withdrawalReceipt)

  status = await optimismPortal.getMessageStatus(withdrawalReceipt)
  console.log(`Withdrawl transaction is ready for relaying: ${thanosSDK.MessageStatus[status]}`)

  const proveTransaction = await optimismPortal.proveWithdrawalTransaction(
    withdrawalMessageInfo
  )
  await proveTransaction.wait()
  console.log(`Proved transaction: ${proveTransaction.hash}`)

  status = await optimismPortal.getMessageStatus(withdrawalReceipt)
  console.log(`Status after proving: ${thanosSDK.MessageStatus[status]}`)

  await optimismPortal.waitForFinalization(withdrawalMessageInfo)
  const finalizedTransaction = await optimismPortal.finalizeWithdrawalTransaction(
    withdrawalMessageInfo
  )
  const finalizedTransactionReceipt = await finalizedTransaction.wait()
  console.log(`Finalize transaction: ${finalizedTransactionReceipt.transactionHash}`)

  status = await optimismPortal.getMessageStatus(withdrawalReceipt)
  console.log(`Status after finalizing: ${thanosSDK.MessageStatus[status]}`)

  const transferTx = await l2NativeTokenContractInL1.transferFrom(
    optimismPortal.contracts.l1.OptimismPortal.address,
    walletAddr,
    withdrawAmount
  )
  await transferTx.wait()
  console.log(`Transfer transaction from OptimismPortal to user: ${transferTx.hash}`)

  await reportBalances()
  console.log(`Withdraw the native token from L2 to L1 takes: ${(new Date() - start) / 1000} seconds`)
}

const packDepositTransaction = (sender, to, value, gasLimit, data) => {
  /** Solidity function
   * function _depositTransaction(
        address _sender,
        address _to,
        uint256 _value,
        uint64 _gasLimit,
        bytes calldata _data,
    )
   */
  const depositData = ethers.utils.solidityPack(
    ['address', 'address', 'uint256', 'uint32', 'bytes'],
    [sender, to, value, gasLimit, data]
  )
  return depositData
}

const depositOnApproveAndCall = async () => {
  console.log(`Deposit native token via approveAndCall function`)
  await reportBalances()
  const start = new Date()

  const depositData = packDepositTransaction(
    l1Wallet.address,
    l1Wallet.address,
    depositAmount.toString(),
    200000,
    '0x'
  )
  console.log(`Deposit data: ${depositData}`)

  const approveTx = await l2NativeTokenContractInL1.approveAndCall(
    optimismPortal.contracts.l1.L1StandardBridge.address,
    depositAmount,
    depositData
  )
  const approveTxReceipt = await approveTx.wait()
  console.log(`Approve and call transaction: ${approveTxReceipt.transactionHash}`)


  const relayTxHash = await optimismPortal.waitingDepositTransactionRelayed(
    approveTxReceipt,
    {}
  )
  if (!relayTxHash) {
    throw new Error("Relay tx hash empty")
  }

  const relayedTxReceipt = await l2RpcProvider.getTransactionReceipt(relayTxHash)

  console.log(`Relayed transaction receipt on L2: ${relayedTxReceipt.transactionHash}`)

  await reportBalances()

  console.log(`Deposit via OptimsimPortal by approveAndCall takes ${(new Date() - start) / 1000} seconds`)

}

const main = async () => {
  await setup();
  // await deposit();
  await depositOnApproveAndCall();
  await withdraw();
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });