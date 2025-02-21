# Zynk Token Manager Client

This is a TypeScript client for interacting with the Zynk Token Manager smart contract on Solana.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file with your configuration:
```bash
# Local network
SOLANA_NETWORK=http://localhost:8899

# Your wallet private key (for development only)
WALLET_PRIVATE_KEY=your_private_key_here
```

3. Run the client:
```bash
npm start
```

## Features

- Initialize a new token manager
- Add tokens to the whitelist
- Remove tokens from the whitelist
- Update admin

## Security Note

Never commit your private keys or sensitive information to version control. Always use environment variables for sensitive data.
