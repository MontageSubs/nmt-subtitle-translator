#!/usr/bin/env node
// 生成一对 RSA-OAEP 2048 位密钥：公钥给静态页面加密请求时间戳用，
// 私钥只交给 Cloudflare Worker（wrangler secret put）解密验证。
// 本脚本纯本地运行，不联网、不上传，生成后请自行妥善保存私钥。
import { webcrypto } from "node:crypto";

const { publicKey, privateKey } = await webcrypto.subtle.generateKey(
  { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true,
  ["encrypt", "decrypt"]
);

const spki = Buffer.from(await webcrypto.subtle.exportKey("spki", publicKey)).toString("base64");
const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", privateKey)).toString("base64");

console.log("公钥（写入 GitHub Pages 部署环境变量 VITE_WORKER_PUBLIC_KEY）：\n");
console.log(spki);
console.log("\n私钥（写入 Worker secret，运行： npx wrangler secret put WORKER_PRIVATE_KEY ，粘贴下面这一整行）：\n");
console.log(pkcs8);
console.log("\n私钥不要提交进仓库、不要写进 wrangler.toml 明文 vars。");
