import sp from "sodium-plus";
import { MAX_INT32 } from "./constants.js";

const { SodiumPlus, CryptographyKey } = sp;

/**
 * Transport encryption interface for RTP packet payloads.
 * Returns [ciphertext, nonceBuffer].
 */
export interface TransportEncryptor {
    encrypt(plaintext: Buffer, additionalData: Buffer): Promise<[Buffer, Buffer]>;
}

/**
 * AES-256-GCM encryption using the Web Crypto API.
 * Preferred when the server supports it.
 */
export class AES256Encryptor implements TransportEncryptor {
    private _nonce = 0;
    private _key: Promise<CryptoKey>;

    constructor(secretKey: Buffer) {
        const keyBytes = new Uint8Array(secretKey);
        this._key = crypto.subtle.importKey(
            "raw", keyBytes,
            { name: "AES-GCM", length: 32 },
            false, ["encrypt"],
        );
    }

    async encrypt(plaintext: Buffer, additionalData: Buffer): Promise<[Buffer, Buffer]> {
        const nonceBuffer = Buffer.alloc(12);
        nonceBuffer.writeUInt32BE(this._nonce);
        this._nonce = (this._nonce + 1) % MAX_INT32;

        const ciphertext = Buffer.from(
            await crypto.subtle.encrypt(
                { name: "AES-GCM", iv: new Uint8Array(nonceBuffer), additionalData: new Uint8Array(additionalData) },
                await this._key,
                new Uint8Array(plaintext),
            ),
        );
        return [ciphertext, nonceBuffer];
    }
}

/**
 * XChaCha20-Poly1305 encryption using sodium-plus.
 * Required fallback — Discord mandates support for this mode.
 */
export class ChaCha20Encryptor implements TransportEncryptor {
    private static sodium = SodiumPlus.auto();
    private _nonce = 0;
    private _key: sp.CryptographyKey;

    constructor(secretKey: Buffer) {
        this._key = new CryptographyKey(secretKey);
    }

    async encrypt(plaintext: Buffer, additionalData: Buffer): Promise<[Buffer, Buffer]> {
        const nonceBuffer = Buffer.alloc(24);
        nonceBuffer.writeUInt32BE(this._nonce);
        this._nonce = (this._nonce + 1) % MAX_INT32;

        const ciphertext = await ChaCha20Encryptor.sodium
            .then(s => s.crypto_aead_xchacha20poly1305_ietf_encrypt(
                plaintext, nonceBuffer, this._key, additionalData,
            ));
        return [ciphertext, nonceBuffer];
    }
}
