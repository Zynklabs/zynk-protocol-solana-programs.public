import fs from 'fs';

const programName = "zynk_core"

const anchorIdl = JSON.parse(fs.readFileSync(`target/idl/${programName}.json`, 'utf8'));

const transformType = (t) => {
  if (typeof t === 'string') {
    if (t === 'pubkey') return 'publicKey';
    return t;
  }
  if (t.option) return { option: transformType(t.option) };
  if (t.array) return { array: [transformType(t.array[0]), t.array[1]] };
  return t;
};

function toCamelCase(str) {
  return str.replace(/_([a-z])/g, (_, l) => l.toUpperCase());
}

const idlJs = {
  name: anchorIdl.metadata.name,
  version: anchorIdl.metadata.version,
  instructions: anchorIdl.instructions.map(ix => ({
    name: toCamelCase(ix.name),
    accounts: ix.accounts.map(acc => ({
      name: toCamelCase(acc.name),
      isMut: acc.writable || false,
      isSigner: acc.signer || false,
    })),
    args: ix.args.map(arg => ({
      name: toCamelCase(arg.name),
      type: transformType(arg.type),
    })),
  })),
  accounts: anchorIdl.types
    .filter(t => t.type.kind === 'struct')
    .map(t => ({
      name: t.name,
      type: {
        kind: 'struct',
        fields: t.type.fields.map(f => ({
          name: toCamelCase(f.name),
          type: transformType(f.type),
        })),
      },
    })),
  errors: anchorIdl.errors?.map(e => ({
    code: e.code,
    name: e.name,
    msg: e.msg,
  })) || [],
};

fs.writeFileSync(`scripts/idls/${programName}.js`, `const IDL = ${JSON.stringify(idlJs, null, 2)};\n\nexport { IDL };`);
