const IDL = {
  "name": "zynk_core",
  "version": "3.0.0",
  "instructions": [
    {
      "name": "ackTimelock",
      "accounts": [
        {
          "name": "config",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "timelock",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "guardian",
          "isMut": true,
          "isSigner": true
        }
      ],
      "args": []
    },
    {
      "name": "attestOrder",
      "accounts": [
        {
          "name": "config",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "manager",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "orderTracker",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "sysvarInstructions",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "orderId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "originChain",
          "type": "string"
        },
        {
          "name": "targetChain",
          "type": "string"
        },
        {
          "name": "origin",
          "type": "string"
        },
        {
          "name": "proxy",
          "type": "string"
        },
        {
          "name": "target",
          "type": "string"
        },
        {
          "name": "txn",
          "type": "string"
        },
        {
          "name": "proxyTxn",
          "type": {
            "option": "string"
          }
        },
        {
          "name": "asset",
          "type": "string"
        },
        {
          "name": "proxyAsset",
          "type": {
            "option": "string"
          }
        },
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "signature",
          "type": {
            "array": [
              "u8",
              64
            ]
          }
        },
        {
          "name": "meta",
          "type": {
            "option": {
              "vec": {
                "defined": "EventArg"
              }
            }
          }
        }
      ]
    },
    {
      "name": "closeOrders",
      "accounts": [
        {
          "name": "config",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "admin",
          "isMut": true,
          "isSigner": true
        }
      ],
      "args": [
        {
          "name": "meta",
          "type": {
            "option": {
              "vec": {
                "defined": "EventArg"
              }
            }
          }
        }
      ]
    },
    {
      "name": "createOrder",
      "accounts": [
        {
          "name": "config",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "manager",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "partnerDepositVault",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "pdvTokenAccount",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "zynkOpWallet",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "zowTokenAccount",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "beneficiaryTokenAccount",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "orderTracker",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "mint",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "tokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "sysvarInstructions",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "partnerId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "orderId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "signature",
          "type": {
            "option": {
              "array": [
                "u8",
                64
              ]
            }
          }
        },
        {
          "name": "meta",
          "type": {
            "option": {
              "vec": {
                "defined": "EventArg"
              }
            }
          }
        }
      ]
    },
    {
      "name": "domainSeparator",
      "accounts": [],
      "args": []
    },
    {
      "name": "executeConsensus",
      "accounts": [
        {
          "name": "config",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "timelock",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "guardian",
          "isMut": true,
          "isSigner": true
        }
      ],
      "args": []
    },
    {
      "name": "executeUnpause",
      "accounts": [
        {
          "name": "config",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "timelock",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "admin",
          "isMut": true,
          "isSigner": true
        }
      ],
      "args": []
    },
    {
      "name": "executeWalletUpdate",
      "accounts": [
        {
          "name": "config",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "timelock",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "admin",
          "isMut": true,
          "isSigner": true
        }
      ],
      "args": []
    },
    {
      "name": "initialize",
      "accounts": [
        {
          "name": "config",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "manager",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "zynkOpWallet",
          "type": "publicKey"
        },
        {
          "name": "admin",
          "type": "publicKey"
        },
        {
          "name": "guardian",
          "type": "publicKey"
        },
        {
          "name": "whitelistedTokenMints",
          "type": {
            "vec": "publicKey"
          }
        }
      ]
    },
    {
      "name": "pause",
      "accounts": [
        {
          "name": "config",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "authority",
          "isMut": false,
          "isSigner": true
        }
      ],
      "args": []
    },
    {
      "name": "pullAndCreateOrder",
      "accounts": [
        {
          "name": "config",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "manager",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "partnerDepositVault",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "pdvTokenAccount",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "zynkOpWallet",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "zowTokenAccount",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "beneficiaryTokenAccount",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "orderTracker",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "mint",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "tokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "sysvarInstructions",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "partnerId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "orderId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "signature",
          "type": {
            "option": {
              "array": [
                "u8",
                64
              ]
            }
          }
        },
        {
          "name": "meta",
          "type": {
            "option": {
              "vec": {
                "defined": "EventArg"
              }
            }
          }
        }
      ]
    },
    {
      "name": "replenish",
      "accounts": [
        {
          "name": "config",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "manager",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "orderTracker",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "partnerDepositVault",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "pdvTokenAccount",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "zowTokenAccount",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "mint",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "tokenProgram",
          "isMut": false,
          "isSigner": false
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "orderId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "validity",
          "type": "i64"
        },
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "closeOrder",
          "type": "bool"
        },
        {
          "name": "meta",
          "type": {
            "option": {
              "vec": {
                "defined": "EventArg"
              }
            }
          }
        }
      ]
    },
    {
      "name": "requestConsensus",
      "accounts": [
        {
          "name": "config",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "timelock",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "manager",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "zynkOpWallet",
          "isMut": false,
          "isSigner": true
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "actionU8",
          "type": "u8"
        },
        {
          "name": "value",
          "type": "publicKey"
        }
      ]
    },
    {
      "name": "requestTimelock",
      "accounts": [
        {
          "name": "config",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "timelock",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "manager",
          "isMut": true,
          "isSigner": true
        },
        {
          "name": "systemProgram",
          "isMut": false,
          "isSigner": false
        }
      ],
      "args": [
        {
          "name": "actionU8",
          "type": "u8"
        },
        {
          "name": "value",
          "type": {
            "option": "publicKey"
          }
        }
      ]
    },
    {
      "name": "revokeTimelock",
      "accounts": [
        {
          "name": "config",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "timelock",
          "isMut": true,
          "isSigner": false
        },
        {
          "name": "admin",
          "isMut": true,
          "isSigner": true
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "Action",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "action",
            "type": "u8"
          },
          {
            "name": "timelock",
            "type": "publicKey"
          },
          {
            "name": "status",
            "type": "u8"
          },
          {
            "name": "timestamp",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "Config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "admin",
            "type": "publicKey"
          },
          {
            "name": "manager",
            "type": "publicKey"
          },
          {
            "name": "guardian",
            "type": "publicKey"
          },
          {
            "name": "zynkOpWallet",
            "type": "publicKey"
          },
          {
            "name": "whitelistedTokenMints",
            "type": {
              "vec": "publicKey"
            }
          }
        ]
      }
    },
    {
      "name": "EventArg",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "key",
            "type": "string"
          },
          {
            "name": "value",
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "OrderAttested",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "orderId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "originChain",
            "type": "string"
          },
          {
            "name": "targetChain",
            "type": "string"
          },
          {
            "name": "origin",
            "type": "string"
          },
          {
            "name": "proxy",
            "type": "string"
          },
          {
            "name": "target",
            "type": "string"
          },
          {
            "name": "txn",
            "type": "string"
          },
          {
            "name": "proxyTxn",
            "type": {
              "option": "string"
            }
          },
          {
            "name": "asset",
            "type": "string"
          },
          {
            "name": "proxyAsset",
            "type": {
              "option": "string"
            }
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "domainSeparator",
            "type": "u64"
          },
          {
            "name": "meta",
            "type": {
              "option": {
                "vec": {
                  "defined": "EventArg"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "OrderCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "orderId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "beneficiaryWallet",
            "type": "publicKey"
          },
          {
            "name": "token",
            "type": "publicKey"
          },
          {
            "name": "partnerDepositVault",
            "type": "publicKey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "transient",
            "type": "bool"
          },
          {
            "name": "domainSeparator",
            "type": "u64"
          },
          {
            "name": "meta",
            "type": {
              "option": {
                "vec": {
                  "defined": "EventArg"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "OrderReplenished",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "orderId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "token",
            "type": "publicKey"
          },
          {
            "name": "partnerDepositVault",
            "type": "publicKey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "orderClosed",
            "type": "bool"
          },
          {
            "name": "domainSeparator",
            "type": "u64"
          },
          {
            "name": "meta",
            "type": {
              "option": {
                "vec": {
                  "defined": "EventArg"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "OrderTracker",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "orderId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "partnerId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "amountIn",
            "type": "u64"
          },
          {
            "name": "amountOut",
            "type": "u64"
          },
          {
            "name": "beneficiaryWallet",
            "type": "publicKey"
          },
          {
            "name": "partnerDepositVault",
            "type": "publicKey"
          }
        ]
      }
    },
    {
      "name": "OrdersClosed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "orderIds",
            "type": {
              "vec": {
                "array": [
                  "u8",
                  32
                ]
              }
            }
          },
          {
            "name": "domainSeparator",
            "type": "u64"
          },
          {
            "name": "meta",
            "type": {
              "option": {
                "vec": {
                  "defined": "EventArg"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "Request",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "action",
            "type": "u8"
          },
          {
            "name": "value",
            "type": "publicKey"
          },
          {
            "name": "eta",
            "type": "i64"
          },
          {
            "name": "executed",
            "type": "bool"
          },
          {
            "name": "ack",
            "type": "bool"
          },
          {
            "name": "consensus",
            "type": "bool"
          }
        ]
      }
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "UnauthorizedSigner",
      "msg": "Unauthorized signer"
    },
    {
      "code": 6001,
      "name": "InvalidAddress",
      "msg": "Invalid address: cannot use null address"
    },
    {
      "code": 6002,
      "name": "ContractPaused",
      "msg": "Contract is paused"
    },
    {
      "code": 6003,
      "name": "UnauthorizedAdmin",
      "msg": "Unauthorized admin"
    },
    {
      "code": 6004,
      "name": "UnauthorizedManager",
      "msg": "Unauthorized manager"
    },
    {
      "code": 6005,
      "name": "UnauthorizedGuardian",
      "msg": "Unauthorized guardian"
    },
    {
      "code": 6006,
      "name": "InvalidOrder",
      "msg": "Invalid order"
    },
    {
      "code": 6007,
      "name": "InvalidAccount",
      "msg": "Invalid account"
    },
    {
      "code": 6008,
      "name": "InvalidTokenMint",
      "msg": "Invalid token mint"
    },
    {
      "code": 6009,
      "name": "ValidityMustBeFuture",
      "msg": "Validity must be in future"
    },
    {
      "code": 6010,
      "name": "DeficientOrder",
      "msg": "Deployed amount must be replenished"
    },
    {
      "code": 6011,
      "name": "InvalidEd25519Message",
      "msg": "Invalid message in Ed25519 instruction"
    },
    {
      "code": 6012,
      "name": "ActionUnderReview",
      "msg": "Action under review"
    },
    {
      "code": 6013,
      "name": "AlreadyExecuted",
      "msg": "Action already executed"
    },
    {
      "code": 6014,
      "name": "InvalidAction",
      "msg": "Invalid action"
    },
    {
      "code": 6015,
      "name": "InvalidPdvAuthority",
      "msg": "Invalid partner deposit vault authority"
    },
    {
      "code": 6016,
      "name": "EmptyWhitelistedTokenMints",
      "msg": "Whitelisted token mints must be non-empty"
    },
    {
      "code": 6017,
      "name": "DuplicateWhitelistedTokenMint",
      "msg": "Whitelisted token mints must be unique"
    }
  ]
};

export { IDL };