type JwkLike = {
  kty?: string;
  crv?: string;
};

type SignatureParams = {
  importAlgorithm: EcKeyImportParams | AlgorithmIdentifier;
  signOrVerifyAlgorithm: EcdsaParams | AlgorithmIdentifier;
};

function getSignatureParamsFromJwk(keyData: JwkLike): SignatureParams {
  if (keyData.kty === 'OKP' && keyData.crv === 'Ed25519') {
    return {
      importAlgorithm: { name: 'Ed25519' },
      signOrVerifyAlgorithm: { name: 'Ed25519' },
    };
  }

  if (keyData.kty === 'EC' && keyData.crv === 'P-256') {
    return {
      importAlgorithm: { name: 'ECDSA', namedCurve: 'P-256' },
      signOrVerifyAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    };
  }

  throw new Error('不支持的签名密钥类型');
}

export async function generateSigningKeyPair(): Promise<CryptoKeyPair> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('当前浏览器不支持 WebCrypto，无法完成注册');
  }

  try {
    return await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  } catch {
    try {
      return await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    } catch {
      throw new Error('当前浏览器不支持签名密钥生成，请升级浏览器后重试');
    }
  }
}

export async function signPayloadWithPrivateJwk(payload: string, keyData: JsonWebKey): Promise<string> {
  const params = getSignatureParamsFromJwk(keyData);
  const privateKey = await crypto.subtle.importKey('jwk', keyData, params.importAlgorithm, false, ['sign']);
  const encoded = new TextEncoder().encode(payload);
  const sig = await crypto.subtle.sign(params.signOrVerifyAlgorithm, privateKey, encoded);
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}