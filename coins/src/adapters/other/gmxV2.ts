import { getLogs } from "../../utils/cache/getLogs";
import { addToDBWritesList, getTokenAndRedirectData } from "../utils/database";
import { Write } from "../utils/dbInterfaces";
import { getApi } from "../utils/sdk";
import * as ethers from 'ethers'

const config: any = {
  arbitrum: [
    { eventEmitter: '0xc8ee91a54287db53897056e12d9819156d3822fb', fromBlock: 107737756, gmReader: '0x38d91ED96283d62182Fc6d990C24097A918a4d9b' },
  ],
  // avax: [
  //   { eventEmitter: '0xDb17B211c34240B014ab6d61d4A31FA0C0e20c26', fromBlock: 32162455, },
  // ],
}

const chains = Object.keys(config)

export function gmxV2(timestamp: number = 0) {
  console.log("starting GMX V2");
  return Promise.all(chains.map(i => getTokenPrices(i, timestamp)))
}

const abis = {
  getMarketTokenPrice: "function getMarketTokenPrice(address dataStore, tuple(address marketToken, address indexToken, address longToken, address shortToken) market, tuple(uint256 min, uint256 max) indexTokenPrice, tuple(uint256 min, uint256 max) longTokenPrice, tuple(uint256 min, uint256 max) shortTokenPrice, bytes32 pnlFactorType, bool maximize) view returns (int256, tuple(int256 poolValue, int256 longPnl, int256 shortPnl, int256 netPnl, uint256 longTokenAmount, uint256 shortTokenAmount, uint256 longTokenUsd, uint256 shortTokenUsd, uint256 totalBorrowingFees, uint256 borrowingFeePoolFactor, uint256 impactPoolAmount))",
  EventLog1: "event EventLog1(address msgSender, string eventName, string indexed eventNameHash, bytes32 indexed topic1, tuple(tuple(tuple(string key, address value)[] items, tuple(string key, address[] value)[] arrayItems) addressItems, tuple(tuple(string key, uint256 value)[] items, tuple(string key, uint256[] value)[] arrayItems) uintItems, tuple(tuple(string key, int256 value)[] items, tuple(string key, int256[] value)[] arrayItems) intItems, tuple(tuple(string key, bool value)[] items, tuple(string key, bool[] value)[] arrayItems) boolItems, tuple(tuple(string key, bytes32 value)[] items, tuple(string key, bytes32[] value)[] arrayItems) bytes32Items, tuple(tuple(string key, bytes value)[] items, tuple(string key, bytes[] value)[] arrayItems) bytesItems, tuple(tuple(string key, string value)[] items, tuple(string key, string[] value)[] arrayItems) stringItems) eventData)",
}

async function getTokenPrices(chain: string, timestamp: number) {
  const api = await getApi(chain, timestamp)

  const configs = config[chain]
  const writes: Write[] = [];
  for (const _config of configs)
    await _getWrites(_config)

  return writes

  async function _getWrites({ eventEmitter, fromBlock, gmReader }: any = {}) {
    const logs = await getLogs({
      api,
      target: eventEmitter,
      topics: ['0x137a44067c8961cd7e1d876f4754a5a3a75989b4552f1843fc69c3b372def160', '0xad5d762f1fc581b3e684cf095d93d3a2c10754f60124b09bec8bf3d76473baaf',], // need both else too many logs
      eventAbi: abis.EventLog1,
      onlyArgs: true,
      fromBlock,
    })


    const underlyingTokens = logs.map((i: any) => {
      const [_, index, long, short] = i[4].addressItems.items.map((i: any) => i.value)
      return [index, long, short]
    }).flat()
    const coinData = await getTokenAndRedirectData(underlyingTokens, chain, timestamp)
    const coinDataObj = Object.fromEntries(coinData.map((i: any) => [i.address.toLowerCase(), i]))
    const symbols: string[] = []
    const marketTokens: string[] = []

    const calls = logs.map((v: any) => {
      const [market, index, long, short] = v[4].addressItems.items.map((i: any) => i.value.toLowerCase())
      if (!coinDataObj[index] || !coinDataObj[long] || !coinDataObj[short]) return;

      if (index === '0x0000000000000000000000000000000000000000') return; // skip for now, until non USDC base is handled correctly
      symbols.push(`${coinDataObj[long].symbol}-${coinDataObj[short].symbol}-GMX-V2`)
      marketTokens.push(market)

      const indexTokenPrice = Math.floor(coinDataObj[index].price * 1e12).toString()
      const longTokenPrice = Math.floor(coinDataObj[long].price * 1e12).toString()
      const shortTokenPrice =  ethers.BigNumber.from(Math.floor(coinDataObj[short].price * 1e8).toString()).mul(ethers.BigNumber.from(10).pow(+coinDataObj[short].decimals + 18 - 8)).toString()

      return {
        params: [
          // datastore address - filled in later
          {
            indexToken: index, longToken: long, shortToken: short, marketToken: market,
          },
          { min: indexTokenPrice, max: indexTokenPrice, },
          { min: longTokenPrice, max: longTokenPrice, },
          { min: shortTokenPrice, max: shortTokenPrice, },
          hashString("MAX_PNL_FACTOR_FOR_DEPOSITS"),
          true,
        ],
      }

    }).filter((i: any) => i)
    const [
      decimals, datastores
    ] = await Promise.all([
      api.multiCall({ abi: 'erc20:decimals', calls: marketTokens }),
      api.multiCall({ abi: 'address:dataStore', calls: marketTokens }),
    ])


    datastores.forEach((i: any, index: number) => calls[index].params.unshift(i))
    const res = await api.multiCall({ abi: abis.getMarketTokenPrice, calls, target: gmReader, permitFailure: true, })
    const prices = res.map((i: any, idx: number) => i[0] / (10 ** (12 + +decimals[idx])))

    marketTokens.forEach((marketToken: string, i: number) => {
      addToDBWritesList(writes, chain, marketToken, +prices[i], decimals[i], symbols[i], timestamp, 'gmx-v2', 0.93)
    })
  }
}


function hashData(dataTypes: any, dataValues: any) {
  const bytes = ethers.utils.defaultAbiCoder.encode(dataTypes, dataValues);
  const hash = ethers.utils.keccak256(ethers.utils.arrayify(bytes));

  return hash;
}

function hashString(string: string) {
  return hashData(["string"], [string]);
}