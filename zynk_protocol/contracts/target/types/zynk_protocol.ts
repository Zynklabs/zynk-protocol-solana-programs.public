/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/zynk_protocol.json`.
 */
export type ZynkProtocol = {
  "address": "7UAhcDLNRpKa4HuCk5MkCLxRGLeRnbjqGxhjePdxPcqB",
  "metadata": {
    "name": "zynkProtocol",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "closeOrder",
      "docs": [
        "Closes the order account and emits closure events.",
        "Only callable by admin."
      ],
      "discriminator": [
        90,
        103,
        209,
        28,
        7,
        63,
        168,
        4
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "orderTracker",
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "orderId",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initialize",
      "docs": [
        "Initialize the protocol with admin, zynk operator wallet, and payback wallet."
      ],
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "zynkOpWallet",
          "type": "pubkey"
        },
        {
          "name": "paybackWallet",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "replenish",
      "docs": [
        "Replenishes tokens by transferring them from the partner_deposit_wallet (deposit_wallet)",
        "to the payback_wallet.",
        "The deposit wallet must match the partner_deposit_wallet recorded in the OrderTracker."
      ],
      "discriminator": [
        209,
        195,
        75,
        71,
        204,
        170,
        131,
        55
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "depositTokenAccount",
          "writable": true
        },
        {
          "name": "paybackTokenAccount",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "depositWallet",
          "signer": true
        },
        {
          "name": "orderTracker",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "orderId",
          "type": "u64"
        },
        {
          "name": "validity",
          "type": "i64"
        },
        {
          "name": "paybackAmount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "send",
      "docs": [
        "Sends tokens from the zynk_op_wallet (operator) to the partner_operational_wallet.",
        "The user provides the token mint, amount, and the partner_deposit_wallet (to be used later for replenish).",
        "This function:",
        "- Checks that the protocol isn’t paused.",
        "- Increments the nonce (to derive a unique, nonzero order ID).",
        "- Transfers tokens from the source token account (owned by zynk_op_wallet) to the partner_operational_wallet.",
        "- Records the order details (order_id and partner_deposit_wallet) in a new OrderTracker account.",
        "- Emits a Send event."
      ],
      "discriminator": [
        102,
        251,
        20,
        187,
        65,
        75,
        12,
        69
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "zynkOpWallet",
          "writable": true,
          "signer": true
        },
        {
          "name": "sourceTokenAccount",
          "writable": true
        },
        {
          "name": "partnerOperationalWallet",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "orderTracker",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "tokenMint",
          "type": "pubkey"
        },
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "partnerDepositWallet",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setPauseState",
      "docs": [
        "Sets the emergency pause state. When paused, send and replenish operations are disabled.",
        "Only callable by admin."
      ],
      "discriminator": [
        130,
        225,
        63,
        203,
        229,
        214,
        138,
        17
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "transferAdmin",
      "docs": [
        "Transfers admin rights to a new admin address. Only callable by the current admin."
      ],
      "discriminator": [
        42,
        242,
        66,
        106,
        228,
        10,
        111,
        156
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "newAdmin",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "updatePaybackWallet",
      "docs": [
        "Updates the payback_wallet address. Only callable by admin."
      ],
      "discriminator": [
        215,
        58,
        254,
        42,
        26,
        165,
        104,
        175
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "newPaybackWallet",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "updateZynkOpWallet",
      "docs": [
        "Updates the zynk_op_wallet (operator) address. Only callable by admin."
      ],
      "discriminator": [
        238,
        211,
        179,
        95,
        243,
        253,
        152,
        213
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "newZynkOpWallet",
          "type": "pubkey"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "orderTracker",
      "discriminator": [
        236,
        101,
        244,
        130,
        161,
        242,
        139,
        49
      ]
    }
  ],
  "events": [
    {
      "name": "replenish",
      "discriminator": [
        81,
        248,
        245,
        98,
        151,
        238,
        225,
        107
      ]
    },
    {
      "name": "replenishClosure",
      "discriminator": [
        152,
        36,
        251,
        132,
        120,
        110,
        170,
        232
      ]
    },
    {
      "name": "send",
      "discriminator": [
        195,
        190,
        139,
        31,
        231,
        31,
        179,
        223
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorizedSender",
      "msg": "Unauthorized sender"
    },
    {
      "code": 6001,
      "name": "invalidAddress",
      "msg": "Invalid address: cannot use null address"
    },
    {
      "code": 6002,
      "name": "contractPaused",
      "msg": "Contract is paused"
    },
    {
      "code": 6003,
      "name": "nonceOverflow",
      "msg": "Nonce overflow"
    },
    {
      "code": 6004,
      "name": "unauthorizedAdmin",
      "msg": "Unauthorized admin"
    },
    {
      "code": 6005,
      "name": "invalidOrderId",
      "msg": "Invalid order ID"
    },
    {
      "code": 6006,
      "name": "invalidTokenMint",
      "msg": "Invalid token mint"
    },
    {
      "code": 6007,
      "name": "validityMustBeFuture",
      "msg": "Validity must be in future"
    },
    {
      "code": 6008,
      "name": "amountMustBePositive",
      "msg": "Amount must be positive"
    }
  ],
  "types": [
    {
      "name": "config",
      "docs": [
        "Stores the admin, the designated operator (zynk_op_wallet), the payback wallet,",
        "and current nonce for send operations."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "zynkOpWallet",
            "type": "pubkey"
          },
          {
            "name": "paybackWallet",
            "type": "pubkey"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "currentNonce",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "orderTracker",
      "docs": [
        "Tracks order details including the designated partner_deposit_wallet"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "orderId",
            "type": "u64"
          },
          {
            "name": "partnerDepositWallet",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "replenish",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "orderId",
            "type": "u64"
          },
          {
            "name": "token",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "status",
            "type": "bool"
          },
          {
            "name": "chainId",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "replenishClosure",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "orderId",
            "type": "u64"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "send",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "orderId",
            "type": "u64"
          },
          {
            "name": "token",
            "type": "pubkey"
          },
          {
            "name": "partnerDepositWallet",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "chainId",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
