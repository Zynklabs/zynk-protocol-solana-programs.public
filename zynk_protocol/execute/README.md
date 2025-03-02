# Zynk Token Manager Client

This is a TypeScript client for interacting with the Zynk Token Manager smart contract on Solana.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Set up wallet keys:

   **Option 1: Use the automatic wallet setup script (recommended for development):**
   ```bash
   npm run setup-wallets
   ```
   This will generate deterministic keypairs (same keypairs every time) and store them in your `.env` file.
   
   **Option 2: Manually create a `.env` file with your own keypairs:**
   Copy from `.env.example` and fill in your keypair values:
```bash
# Wallet Private Keys (Array format as exported by Solana CLI)
# Example format: [1,2,3,4,...] - a serialized array of bytes
ADMIN_WALLET_PRIVATE_KEY=[...]
ZYNK_OP_WALLET_PRIVATE_KEY=[...]
PAYBACK_WALLET_PRIVATE_KEY=[...]
CONFIG_ACCOUNT_PRIVATE_KEY=[...]
PARTNER_OPERATIONAL_WALLET_PRIVATE_KEY=[...]
PARTNER_DEPOSIT_WALLET_PRIVATE_KEY=[...]

# Optional: RPC Connection URL (defaults to localhost)
RPC_URL=http://localhost:8899
```

3. Run the client:
```bash
npm start
```

## How to Get Private Keys

To get the private key for a Solana keypair:

1. If you have a keypair file (e.g., `id.json`), you can extract the private key array directly.

2. Using Solana CLI:
   ```bash
   # Export a keypair to a JSON file
   solana-keygen new -o my-keypair.json
   
   # View the contents of the file to get the private key array
   cat my-keypair.json
   ```

3. Copy the entire array (including brackets) to the appropriate environment variable in your `.env` file.

## The Wallet Setup Script

The `setup-wallets.ts` script:
- Generates deterministic keypairs using cryptographic hashing of predefined seeds
- Writes the private keys to your `.env` file
- Only updates keys that aren't already defined
- Preserves other environment variables in your `.env` file

This is particularly useful for development and testing where you need consistent keypairs across different runs or team members.

## The Airdrop Script

The `airdrop.ts` script allows you to fund all wallets defined in your `.env` file using a master wallet from your local system:

```bash
# Generic command with custom options
npm run airdrop -- --wallet ~/.config/solana/id.json --amount 1

# Predefined commands
npm run airdrop:local  # Use local Solana node with 0.1 SOL per wallet
npm run airdrop:devnet # Use Solana Devnet with 1 SOL per wallet
```

Options:
- `--wallet <path>` - Path to your master wallet keypair JSON file (required)
- `--amount <number>` - Amount of SOL to airdrop to each wallet (default: 0.1)
- `--rpc <url>` - Solana RPC URL (defaults to value in .env or localhost)

The script will:
1. Load your master wallet from the specified path
2. Connect to the Solana network (local or specified RPC)
3. Check if your master wallet has enough SOL for all transfers
4. Transfer the specified amount of SOL to each wallet defined in the `.env` file

This is useful when you need to quickly fund multiple wallets for testing purposes.

## Fallback Behavior

If a private key is not provided in the `.env` file or cannot be parsed, the application will automatically generate a new keypair. This is useful for testing but not recommended for production use since the keypair will be different each time you run the application.

## Features

- Initialize a new token manager
- Add tokens to the whitelist
- Remove tokens from the whitelist
- Update admin

## Security Note

Never commit your private keys or sensitive information to version control. Always use environment variables for sensitive data.
