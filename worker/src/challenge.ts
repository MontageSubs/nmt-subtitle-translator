export interface Op {
  kind: "xor" | "add" | "mul" | "rotl";
  operand: number;
}

const OP_KINDS: Op["kind"][] = ["xor", "add", "mul", "rotl"];
const OP_COUNT = 6;
const VAR_POOL = ["q", "z", "k", "m", "x", "y", "w", "r", "n", "p", "v", "j", "d", "f", "g", "h"];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

export function deriveOps(seed: number): Op[] {
  const rand = mulberry32(seed);
  return Array.from({ length: OP_COUNT }, () => ({
    kind: pick(rand, OP_KINDS),
    operand: (Math.floor(rand() * 0xffffffff) >>> 0) || 1,
  }));
}

function rotl(value: number, bits: number): number {
  const b = bits % 32 || 1;
  return ((value << b) | (value >>> (32 - b))) >>> 0;
}

function applyOp(value: number, op: Op): number {
  switch (op.kind) {
    case "xor": return (value ^ op.operand) >>> 0;
    case "add": return (value + op.operand) >>> 0;
    case "mul": return Math.imul(value, op.operand) >>> 0;
    case "rotl": return rotl(value, op.operand);
  }
}

export function computeAnswer(seed: number, text: string, ops: Op[]): number {
  let acc = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    acc = (acc ^ ((text.charCodeAt(i) + i * 131) >>> 0)) >>> 0;
    for (const op of ops) acc = applyOp(acc, op);
  }
  return acc % 1000000;
}

function opExpr(varName: string, op: Op): string {
  switch (op.kind) {
    case "xor": return `${varName}=(${varName}^${op.operand})>>>0`;
    case "add": return `${varName}=(${varName}+${op.operand})>>>0`;
    case "mul": return `${varName}=Math.imul(${varName},${op.operand})>>>0`;
    case "rotl": {
      const bits = op.operand % 32 || 1;
      return `${varName}=((${varName}<<${bits})|(${varName}>>>(32-${bits})))>>>0`;
    }
  }
}

function shuffledNames(rand: () => number, count: number): string[] {
  const pool = [...VAR_POOL];
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return out;
}

export function renderChallengeSource(seed: number, ops: Op[]): string {
  const rand = mulberry32(seed ^ 0x9e3779b9);
  const [acc, i] = shuffledNames(rand, 2);
  const junkLines = Array.from({ length: 2 + Math.floor(rand() * 3) }, () => {
    const v = pick(rand, VAR_POOL);
    return `let ${v}=${Math.floor(rand() * 1e6)};${v}=(${v}*${Math.floor(rand() * 97) + 1})>>>0;`;
  }).join("");
  const opLines = ops.map((op) => opExpr(acc, op)).join(";");
  return [
    `let ${acc}=seed>>>0;`,
    junkLines,
    `for(let ${i}=0;${i}<text.length;${i}++){`,
    `${acc}=(${acc}^((text.charCodeAt(${i})+${i}*131)>>>0))>>>0;`,
    `${opLines};`,
    `}`,
    `return ${acc}%1000000;`,
  ].join("");
}
