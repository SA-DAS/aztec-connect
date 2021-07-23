import {
  AccountId,
  AssetId,
  BridgeId,
  createWalletSdk,
  EthAddress,
  TxType,
  WalletProvider,
  WalletSdk,
} from '@aztec/sdk';
import { EventEmitter } from 'events';
import { createFundedWalletProvider } from './create_funded_wallet_provider';

jest.setTimeout(10 * 60 * 1000);
EventEmitter.defaultMaxListeners = 30;

const { ETHEREUM_HOST = 'http://localhost:8545', ROLLUP_HOST = 'http://localhost:8081' } = process.env;

/**
 * Run the following:
 * blockchain: yarn start:ganache
 * halloumi: yarn start:dev
 * falafel: yarn start:dev
 * end-to-end: yarn test e2e_defi
 */

describe('end-to-end defi tests', () => {
  let provider: WalletProvider;
  let sdk: WalletSdk;
  let accounts: EthAddress[] = [];
  const userIds: AccountId[] = [];
  const awaitSettlementTimeout = 600;

  beforeAll(async () => {
    provider = await createFundedWalletProvider(ETHEREUM_HOST, 2, '1');
    accounts = provider.getAccounts();

    sdk = await createWalletSdk(provider, ROLLUP_HOST, {
      syncInstances: false,
      saveProvingKey: false,
      clearDb: true,
      dbPath: ':memory:',
      minConfirmation: 1,
      minConfirmationEHW: 1,
    });
    await sdk.init();
    await sdk.awaitSynchronised();

    for (let i = 0; i < accounts.length; i++) {
      const user = await sdk.addUser(provider.getPrivateKeyForAddress(accounts[i])!);
      userIds.push(user.id);
    }
  });

  afterAll(async () => {
    await sdk.destroy();
  });

  it('should make a defi deposit', async () => {
    const userId = userIds[0];
    const depositor = accounts[0];

    // Shield
    {
      const assetId = AssetId.ETH;
      const value = sdk.toBaseUnits(assetId, '0.8');
      const txFee = await sdk.getFee(assetId, TxType.DEPOSIT);

      const signer = sdk.createSchnorrSigner(provider.getPrivateKeyForAddress(depositor)!);
      const proofOutput = await sdk.createDepositProof(assetId, depositor, userId, value, txFee, signer);
      const signature = await sdk.signProof(proofOutput, depositor);

      await sdk.depositFundsToContract(assetId, depositor, value + txFee);

      const txHash = await sdk.sendProof(proofOutput, signature);
      await sdk.awaitSettlement(txHash, awaitSettlementTimeout);

      expect(sdk.getBalance(assetId, userId)).toBe(value);
    }

    // Defi deposit - swap ETH to DAI
    {
      const defiBridge = EthAddress.fromString('0xc5a5C42992dECbae36851359345FE25997F5C42d');
      const inputAssetId = AssetId.ETH;
      const outputAssetIdA = AssetId.DAI;
      const outputAssetIdB = 0;
      const bridgeId = new BridgeId(defiBridge, 1, inputAssetId, outputAssetIdA, outputAssetIdB);
      const txFee = await sdk.getFee(inputAssetId, TxType.DEFI_DEPOSIT);
      const depositValue = sdk.toBaseUnits(inputAssetId, '0.5');

      const initialBalance = sdk.getBalance(inputAssetId, userId);

      const signer = sdk.createSchnorrSigner(provider.getPrivateKeyForAddress(depositor)!);
      const proofOutput = await sdk.createDefiProof(bridgeId, userId, depositValue, txFee, signer);

      const txHash = await sdk.sendProof(proofOutput);
      await sdk.awaitSettlement(txHash, awaitSettlementTimeout);

      const defiTxs = await sdk.getDefiTxs(userId);
      expect(defiTxs.length).toBe(1);
      const defiTx = defiTxs[0];
      expect(defiTx).toMatchObject({
        bridgeId,
        depositValue,
        txFee,
        outputValueA: 949659475163118540743n,
        outputValueB: 0n,
      });
      expect(sdk.getBalance(outputAssetIdA, userId)).toBe(defiTx.outputValueA);
      expect(sdk.getBalance(inputAssetId, userId)).toBe(initialBalance - depositValue - txFee);
    }

    // Defi deposit - swap DAI to ETH
    {
      const defiBridge = EthAddress.fromString('0xE6E340D132b5f46d1e472DebcD681B2aBc16e57E');
      const inputAssetId = AssetId.DAI;
      const bridgeId = new BridgeId(defiBridge, 1, inputAssetId, AssetId.ETH, 0);
      const txFee = await sdk.getFee(inputAssetId, TxType.DEFI_DEPOSIT);
      const depositValue = sdk.toBaseUnits(inputAssetId, '100');

      const initialEthBalance = sdk.getBalance(AssetId.ETH, userId);
      const initialDaiBalance = sdk.getBalance(AssetId.DAI, userId);

      const signer = sdk.createSchnorrSigner(provider.getPrivateKeyForAddress(depositor)!);
      const proofOutput = await sdk.createDefiProof(bridgeId, userId, depositValue, txFee, signer);

      const txHash = await sdk.sendProof(proofOutput);
      await sdk.awaitSettlement(txHash, awaitSettlementTimeout);

      const defiTxs = await sdk.getDefiTxs(userId);
      expect(defiTxs.length).toBe(2);
      const defiTx = defiTxs[0];
      expect(defiTx).toMatchObject({
        bridgeId,
        depositValue,
        txFee,
        outputValueA: 54665680662256300n,
        outputValueB: 0n,
      });
      expect(sdk.getBalance(AssetId.ETH, userId)).toBe(initialEthBalance + defiTx.outputValueA);
      expect(sdk.getBalance(AssetId.DAI, userId)).toBe(initialDaiBalance - txFee - depositValue);
    }
  });
});