import { assetDataUtils } from '@0xproject/order-utils';
import { BigNumber } from '@0xproject/utils';
import { Web3Wrapper } from '@0xproject/web3-wrapper';
import { Provider, TxData } from 'ethereum-types';

import { ArtifactWriter } from '../utils/artifact_writer';
import { erc20TokenInfo, erc721TokenInfo } from '../utils/token_info';

import { artifacts } from './artifacts';
import { AssetProxyOwnerContract } from './contract_wrappers/asset_proxy_owner';
import { DummyERC20TokenContract } from './contract_wrappers/dummy_erc20_token';
import { DummyERC721TokenContract } from './contract_wrappers/dummy_erc721_token';
import { ERC20ProxyContract } from './contract_wrappers/erc20_proxy';
import { ERC721ProxyContract } from './contract_wrappers/erc721_proxy';
import { ExchangeContract } from './contract_wrappers/exchange';
import { ForwarderContract } from './contract_wrappers/forwarder';
import { MultiAssetProxyContract } from './contract_wrappers/multi_asset_proxy';
import { OrderValidatorContract } from './contract_wrappers/order_validator';
import { WETH9Contract } from './contract_wrappers/weth9';
import { ZRXTokenContract } from './contract_wrappers/zrx_token';

/**
 * Custom migrations should be defined in this function. This will be called with the CLI 'migrate:v2' command.
 * Migrations could be written to run in parallel, but if you want contract addresses to be created deterministically,
 * the migration should be written to run synchronously.
 * @param provider  Web3 provider instance.
 * @param artifactsDir The directory with compiler artifact files.
 * @param txDefaults Default transaction values to use when deploying contracts.
 */
export const runV2MigrationsAsync = async (provider: Provider, artifactsDir: string, txDefaults: Partial<TxData>) => {
    const web3Wrapper = new Web3Wrapper(provider);
    const networkId = await web3Wrapper.getNetworkIdAsync();
    const artifactsWriter = new ArtifactWriter(artifactsDir, networkId);
    const zrxToken = { address: '0xe41d2489571d322189246dafa5ebde1f4699f498' };
    const etherToken = { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' };
    const multiSigOwners: string[] = [
        '0x257619b7155d247e43c8b6d90c8c17278ae481f0',
        '0x5ee2a00f8f01d099451844af7f894f26a57fcbf2',
        '0x894d623e0e0e8ed12c4a73dada999e275684a37d',
    ];
    // Multisigs
    const confirmationsRequired = new BigNumber(2);
    const secondsRequired = new BigNumber(1209600); // 14 days

    // REPLACE ME
    const defaultAccount = (await web3Wrapper.getAvailableAddressesAsync())[0]; // REPLACE WITH DEPLOYER ACCOUNT
    const owner = defaultAccount;

    // Proxies
    const erc20proxy = await ERC20ProxyContract.deployFrom0xArtifactAsync(artifacts.ERC20Proxy, provider, txDefaults);
    artifactsWriter.saveArtifact(erc20proxy);
    const erc721proxy = await ERC721ProxyContract.deployFrom0xArtifactAsync(
        artifacts.ERC721Proxy,
        provider,
        txDefaults,
    );
    artifactsWriter.saveArtifact(erc721proxy);
    const multiAssetProxy = await MultiAssetProxyContract.deployFrom0xArtifactAsync(
        artifacts.MultiAssetProxy,
        provider,
        txDefaults,
    );

    // Exchange
    const zrxAssetData = assetDataUtils.encodeERC20AssetData(zrxToken.address);
    const exchange = await ExchangeContract.deployFrom0xArtifactAsync(
        artifacts.Exchange,
        provider,
        txDefaults,
        zrxAssetData,
    );
    artifactsWriter.saveArtifact(exchange);

    // AssetProxyOwner
    const assetProxyOwner = await AssetProxyOwnerContract.deployFrom0xArtifactAsync(
        artifacts.AssetProxyOwner,
        provider,
        txDefaults,
        multiSigOwners,
        [erc20proxy.address, erc721proxy.address, multiAssetProxy.address],
        confirmationsRequired,
        secondsRequired,
    );

    // Allow Exchange to call ERC20
    await web3Wrapper.awaitTransactionSuccessAsync(
        await erc20proxy.addAuthorizedAddress.sendTransactionAsync(exchange.address, {
            from: owner,
        }),
    );
    // Allow MAP to call ERC20
    await web3Wrapper.awaitTransactionSuccessAsync(
        await erc20proxy.addAuthorizedAddress.sendTransactionAsync(multiAssetProxy.address, {
            from: owner,
        }),
    );
    // Transfer ERC20 ownership
    await web3Wrapper.awaitTransactionSuccessAsync(
        await erc20proxy.transferOwnership.sendTransactionAsync(assetProxyOwner.address, {
            from: owner,
        }),
    );
    // Allow Exchange to call ERC721
    await web3Wrapper.awaitTransactionSuccessAsync(
        await erc721proxy.addAuthorizedAddress.sendTransactionAsync(exchange.address, {
            from: owner,
        }),
    );
    // Allow MAP to call ERC721
    await web3Wrapper.awaitTransactionSuccessAsync(
        await erc721proxy.addAuthorizedAddress.sendTransactionAsync(multiAssetProxy.address, {
            from: owner,
        }),
    );
    // Transfer ERC721 ownership
    await web3Wrapper.awaitTransactionSuccessAsync(
        await erc721proxy.transferOwnership.sendTransactionAsync(assetProxyOwner.address, {
            from: owner,
        }),
    );

    // Register Asset Proxies to the MAP
    await web3Wrapper.awaitTransactionSuccessAsync(
        await multiAssetProxy.registerAssetProxy.sendTransactionAsync(erc20proxy.address, { from: owner }),
    );
    await web3Wrapper.awaitTransactionSuccessAsync(
        await multiAssetProxy.registerAssetProxy.sendTransactionAsync(erc721proxy.address, { from: owner }),
    );
    // Transfer MAP ownership
    await web3Wrapper.awaitTransactionSuccessAsync(
        await multiAssetProxy.transferOwnership.sendTransactionAsync(assetProxyOwner.address, {
            from: owner,
        }),
    );

    // Register the Asset Proxies to the Exchange
    await web3Wrapper.awaitTransactionSuccessAsync(
        await exchange.registerAssetProxy.sendTransactionAsync(erc20proxy.address),
    );
    await web3Wrapper.awaitTransactionSuccessAsync(
        await exchange.registerAssetProxy.sendTransactionAsync(erc721proxy.address),
    );
    await web3Wrapper.awaitTransactionSuccessAsync(
        await exchange.registerAssetProxy.sendTransactionAsync(multiAssetProxy.address),
    );

    console.log('exchange transfer ownership');
    // Transfer Ownership of Exchange contract to asset proxy owner multisig
    await web3Wrapper.awaitTransactionSuccessAsync(
        await exchange.transferOwnership.sendTransactionAsync(assetProxyOwner.address),
    );

    console.log('forwarder');
    // Forwarder
    const forwarder = await ForwarderContract.deployFrom0xArtifactAsync(
        artifacts.Forwarder,
        provider,
        txDefaults,
        exchange.address,
        assetDataUtils.encodeERC20AssetData(zrxToken.address),
        assetDataUtils.encodeERC20AssetData(etherToken.address),
    );
    artifactsWriter.saveArtifact(forwarder);

    // OrderValidator
    const orderValidator = await OrderValidatorContract.deployFrom0xArtifactAsync(
        artifacts.OrderValidator,
        provider,
        txDefaults,
        exchange.address,
        zrxAssetData,
    );
    artifactsWriter.saveArtifact(orderValidator);
};
