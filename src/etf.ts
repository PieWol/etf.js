// /**
//  * Encryption to the Future
//  * This class initializes the ETF.js SDK
//  */

import { ApiPromise, WsProvider } from "@polkadot/api";
import { Compact, Metadata, TypeRegistry } from "@polkadot/types";
import { BlockNumber } from "@polkadot/types/interfaces";
import { hexToU8a  } from "@polkadot/util";
import init, { EtfApiWrapper } from "etf-sdk";

import { readFileSync } from 'fs';
import * as smoldot from 'smoldot';
/**
 * The slot schedule holds a list of slot ids which are intended to be used in etf
 */
class SlotSchedule {
    public slotIds: number[];
    constructor(slotIds: number[]) {
        this.slotIds = slotIds;
    }
}

export interface SlotScheduler<T> {
    generateSchedule(n: number, currentSlot: number, input: T): SlotSchedule;
}

export class TimeInput {
    distance: number;
    constructor(distance: number) {
        this.distance = distance;
    }
}

/**
 * Select slots randomly between the latest known slot and a future slot
 */
export class DistanceBasedSlotScheduler implements SlotScheduler<TimeInput> {

    generateSchedule(n: number, currentSlot: number, input: TimeInput): SlotSchedule {
        // const currentSlot = Math.floor(input.currentSlot + 1);
        const distance = Math.floor(input.distance);
        if (n > distance) {
            throw new Error("number of slots must be less than total slots");
        }
        let terminalSlot = (currentSlot + 1) + distance * 2;
        const slotIds: number[] = [];

        // Generate n random slot IDs between currentSlot+1 and terminalSlot
        // ensuring multiples of 2
        for (let i = 0; i < n; i++) {
            const range = Math.floor((terminalSlot - currentSlot + 1) / 2);
            const randomSlot = currentSlot + Math.floor(Math.random() * range) * 2;
            slotIds.push(randomSlot);
        }

        slotIds.sort();
        return new SlotSchedule(slotIds);
    }
}

/**
 * Encryption to the Future
 * This class initializes the ETF.js SDK
 * It assumes a time-based SlotScheduler
 */
export class Etf<T> {
    public latestSlot: any;
    public latestBlockNumber: Compact<BlockNumber>;
    private host: string;
    private port: number;
    private api!: ApiPromise;
    private registry!: TypeRegistry;
    private etfApi!: EtfApiWrapper;
    private slotScheduler!: SlotScheduler<T>;

    constructor(host: string, port: number, slotScheduler: SlotScheduler<T>) {
        this.host = host;
        this.port = port;
        this.slotScheduler = slotScheduler
    }

    // connect to the chain and init wasm
    async init(): Promise<void> {

        // if (doUseLightClient) {
        //     const chainSpec = readFileSync('./etfTestSpecRaw.json', 'utf-8');
        //     const client = smoldot.start();
        //     const chain = await client.addChain({ chainSpec });
        // }

        const provider = new WsProvider(`ws://${this.host}:${this.port}`);
        
        // setup api for blockchain
        this.api = await ApiPromise.create({ provider });
        await this.api.isReady;
        this.registry = new TypeRegistry();

        // load metadata and predigest
        const data = await this.api.rpc.state.getMetadata();
        this.registry.register({
            PreDigest: {
                slot: 'u64',
                secret: '[u8;48]',
                proof: '([u8;48], [u8;48], [u8;32], [u8;48])'
            }
        });

        const metadata = new Metadata(this.registry, data.toHex());
        this.registry.setMetadata(metadata);
        this.listenForSecrets();

        // we want to load the ibe public params here
        const pps = await this.api.query.etf.ibeParams();

        await init();
        console.log('wasm initialized successfully');

        this.etfApi = new EtfApiWrapper(pps[1], pps[2]);
        console.log('etf api initialized');

        const version = String.fromCharCode(...this.etfApi.version());
        console.log('version ' + version);
    }

    /**
     * Encrypt a message 
     * @param message The message to encrypt
     * @param n The number of slots to encrypt for
     * @param schedulerInput The schedulerInput for the slot scheduler 
     * @returns the ciphertext and slot schedule
     */
    encrypt(message: string, n: number, threshold: number, schedulerInput: T) {
        let slotSchedule = 
            this.slotScheduler.generateSchedule(n, this.getLatestSlot(), schedulerInput);
        let t = new TextEncoder();
        let ids = [];
        for (const id of slotSchedule.slotIds) {
            ids.push(t.encode(id.toString()));
        }
        return {
            ct: this.etfApi.encrypt(message, ids, threshold), 
            slotSchedule: slotSchedule
        };
    }

    /**
     * 
     * @param ct 
     * @param nonce 
     * @param capsule 
     * @param slotSchedule 
     * @returns 
     */
    async decrypt(
        ct: Uint8Array, 
        nonce: Uint8Array, 
        capsule: Uint8Array,
        slotSchedule: SlotSchedule
    ) {
        let sks: Uint8Array[] = [];
        let latest = this.getLatestSlot();
        let slotIds: number[] = slotSchedule.slotIds;
        for (const slotId of slotIds) {
            let distance = (latest - slotId) / 2;
            let blockNumber = this.latestBlockNumber.toNumber() - distance;
            let blockHash = await this.api.rpc.chain.getBlockHash(blockNumber);
            let blockHeader = await this.api.rpc.chain.getHeader(blockHash);
            let encodedPreDigest = blockHeader.digest.logs[0].toHuman().PreRuntime[1];
            const predigest = this.registry.createType('PreDigest', encodedPreDigest);
            let sk: Uint8Array = hexToU8a(predigest.secret.toString());
            sks.push(sk);
        }
        return this.etfApi.decrypt(ct, nonce, capsule, sks);
    }

    // listen for incoming block headers and emit an event 
    // when new headers are encountered
    // currently stores no history
    private listenForSecrets(): void {
        this.api.derive.chain.subscribeNewHeads(async (header) => {
            // read the predigest from each block
            const encodedPreDigest = header.digest.logs[0].toHuman().PreRuntime[1];
            const predigest = this.registry.createType('PreDigest', encodedPreDigest);

            let latest = predigest.toHuman();
            this.latestSlot = latest;
            this.latestBlockNumber = header["number"];
            const event = new CustomEvent('blockHeader', { detail: latest });
            document.dispatchEvent(event);
        });
    }

    public getLatestSlot() {
        return Number.parseInt(this.latestSlot.slot.replaceAll(",", ""));
    }
}