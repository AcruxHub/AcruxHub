/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/acruxhub_bridge.json`.
 */
export type AcruxhubBridge = {
  "address": "D3ct55qQUcEp8RBiD6xU5e923yGN6B1SopFMNhQTc3CT",
  "metadata": {
    "name": "acruxhubBridge",
    "version": "0.1.0",
    "spec": "0.1.0"
  },
  "instructions": [
    {
      "name": "approve",
      "docs": [
        "A guardian approves an inbound payload observed (finalized) on the source chain."
      ],
      "discriminator": [
        69,
        74,
        217,
        36,
        115,
        117,
        97,
        76
      ],
      "accounts": [
        {
          "name": "guardian",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
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
          "name": "approval",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  112,
                  112,
                  114,
                  111,
                  118,
                  97,
                  108
                ]
              },
              {
                "kind": "arg",
                "path": "payload"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "payload",
          "type": {
            "defined": {
              "name": "payload"
            }
          }
        }
      ]
    },
    {
      "name": "execute",
      "docs": [
        "Anyone: executes an approved payload once, releasing custody or minting wrapped tokens."
      ],
      "discriminator": [
        130,
        221,
        242,
        154,
        13,
        193,
        189,
        29
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "config",
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
          "name": "approval"
        },
        {
          "name": "consumed",
          "docs": [
            "Exists once per (source_chain, nonce): a second execute of any payload for it fails here."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  115,
                  117,
                  109,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "approval.payload.source_chain",
                "account": "approval"
              },
              {
                "kind": "account",
                "path": "approval.payload.nonce",
                "account": "approval"
              }
            ]
          }
        },
        {
          "name": "route",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "writable": true
        },
        {
          "name": "custody",
          "docs": [
            "Required for native routes."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  115,
                  116,
                  111,
                  100,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "recipient"
        },
        {
          "name": "recipientTokens",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "recipient"
              },
              {
                "kind": "const",
                "value": [
                  6,
                  221,
                  246,
                  225,
                  215,
                  101,
                  161,
                  147,
                  217,
                  203,
                  225,
                  70,
                  206,
                  235,
                  121,
                  172,
                  28,
                  180,
                  133,
                  237,
                  95,
                  91,
                  55,
                  145,
                  58,
                  140,
                  245,
                  133,
                  126,
                  255,
                  0,
                  169
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initialize",
      "docs": [
        "One-time setup, gated on the upgrade authority."
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
          "name": "admin",
          "writable": true,
          "signer": true
        },
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
          "name": "program",
          "address": "D3ct55qQUcEp8RBiD6xU5e923yGN6B1SopFMNhQTc3CT"
        },
        {
          "name": "programData"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "chainId",
          "type": "u16"
        },
        {
          "name": "guardians",
          "type": {
            "vec": "pubkey"
          }
        },
        {
          "name": "threshold",
          "type": "u8"
        }
      ]
    },
    {
      "name": "pause",
      "docs": [
        "Emergency stop: the admin or any single guardian."
      ],
      "discriminator": [
        211,
        22,
        221,
        251,
        74,
        121,
        193,
        47
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
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
        }
      ],
      "args": []
    },
    {
      "name": "registerNative",
      "docs": [
        "Registers a token native to this chain: outbound locks it in custody."
      ],
      "discriminator": [
        171,
        31,
        247,
        227,
        166,
        30,
        98,
        195
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
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
          "name": "mint"
        },
        {
          "name": "route",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "custody",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  115,
                  116,
                  111,
                  100,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "remoteChain",
          "type": "u16"
        },
        {
          "name": "remoteMint",
          "type": "pubkey"
        },
        {
          "name": "dailyCap",
          "type": "u64"
        }
      ]
    },
    {
      "name": "registerWrapped",
      "docs": [
        "Registers the wrapped form of a token native to `remote_chain`. The wrapped",
        "mint is a PDA of this program; its decimals must equal the remote mint's."
      ],
      "discriminator": [
        36,
        106,
        99,
        218,
        34,
        7,
        20,
        211
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
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
          "name": "mint",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  114,
                  97,
                  112,
                  112,
                  101,
                  100
                ]
              },
              {
                "kind": "arg",
                "path": "remoteChain"
              },
              {
                "kind": "arg",
                "path": "remoteMint"
              }
            ]
          }
        },
        {
          "name": "route",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "remoteChain",
          "type": "u16"
        },
        {
          "name": "remoteMint",
          "type": "pubkey"
        },
        {
          "name": "decimals",
          "type": "u8"
        },
        {
          "name": "dailyCap",
          "type": "u64"
        }
      ]
    },
    {
      "name": "send",
      "docs": [
        "Locks (native) or burns (wrapped) `amount` and records the transfer for the guardians."
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
          "name": "user",
          "writable": true,
          "signer": true
        },
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
          "name": "route",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  111,
                  117,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "mint",
          "writable": true
        },
        {
          "name": "userTokens",
          "writable": true
        },
        {
          "name": "custody",
          "docs": [
            "Required for native routes."
          ],
          "writable": true,
          "optional": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  117,
                  115,
                  116,
                  111,
                  100,
                  121
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "outbound",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  117,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "config.next_nonce",
                "account": "config"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "recipient",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setAdmin",
      "discriminator": [
        251,
        163,
        0,
        52,
        91,
        194,
        187,
        92
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
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
      "name": "setCap",
      "discriminator": [
        209,
        207,
        121,
        129,
        115,
        39,
        220,
        4
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "config",
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
          "name": "route",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "dailyCap",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setGuardians",
      "docs": [
        "Replaces the guardian set. Pending approvals from the old set stop counting."
      ],
      "discriminator": [
        166,
        69,
        140,
        183,
        157,
        169,
        253,
        40
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
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
        }
      ],
      "args": [
        {
          "name": "guardians",
          "type": {
            "vec": "pubkey"
          }
        },
        {
          "name": "threshold",
          "type": "u8"
        }
      ]
    },
    {
      "name": "unpause",
      "discriminator": [
        169,
        144,
        4,
        38,
        10,
        141,
        188,
        255
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
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
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "approval",
      "discriminator": [
        233,
        9,
        153,
        49,
        11,
        222,
        59,
        130
      ]
    },
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
      "name": "consumed",
      "discriminator": [
        66,
        210,
        14,
        177,
        124,
        128,
        131,
        151
      ]
    },
    {
      "name": "outbound",
      "discriminator": [
        37,
        242,
        11,
        107,
        242,
        156,
        70,
        129
      ]
    },
    {
      "name": "route",
      "discriminator": [
        80,
        179,
        58,
        115,
        52,
        19,
        146,
        134
      ]
    }
  ],
  "events": [
    {
      "name": "approved",
      "discriminator": [
        17,
        224,
        150,
        137,
        174,
        104,
        7,
        91
      ]
    },
    {
      "name": "executed",
      "discriminator": [
        8,
        232,
        139,
        132,
        197,
        45,
        29,
        164
      ]
    },
    {
      "name": "guardiansChanged",
      "discriminator": [
        178,
        170,
        191,
        233,
        236,
        149,
        0,
        124
      ]
    },
    {
      "name": "pauseChanged",
      "discriminator": [
        238,
        188,
        213,
        78,
        134,
        209,
        178,
        218
      ]
    },
    {
      "name": "sent",
      "discriminator": [
        230,
        90,
        111,
        254,
        186,
        174,
        45,
        74
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "Signer is not authorized"
    },
    {
      "code": 6001,
      "name": "badGuardians",
      "msg": "Guardians must be unique, 1-16, with a strict-majority threshold"
    },
    {
      "code": 6002,
      "name": "paused",
      "msg": "Bridge is paused"
    },
    {
      "code": 6003,
      "name": "zeroAmount",
      "msg": "Amount is zero"
    },
    {
      "code": 6004,
      "name": "badRecipient",
      "msg": "Recipient is invalid or does not match the payload"
    },
    {
      "code": 6005,
      "name": "wrongChain",
      "msg": "Payload is not for this chain"
    },
    {
      "code": 6006,
      "name": "staleApprovals",
      "msg": "Approvals are from a previous guardian set"
    },
    {
      "code": 6007,
      "name": "notEnoughApprovals",
      "msg": "Not enough guardian approvals"
    },
    {
      "code": 6008,
      "name": "routeMismatch",
      "msg": "Route does not match the payload"
    },
    {
      "code": 6009,
      "name": "capExceeded",
      "msg": "Daily cap exceeded for this token"
    },
    {
      "code": 6010,
      "name": "missingAccount",
      "msg": "A required account is missing"
    },
    {
      "code": 6011,
      "name": "overflow",
      "msg": "Arithmetic overflow"
    }
  ],
  "types": [
    {
      "name": "approval",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "digest",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "payload",
            "type": {
              "defined": {
                "name": "payload"
              }
            }
          },
          {
            "name": "guardianSet",
            "type": "u32"
          },
          {
            "name": "signers",
            "type": "u16"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "approved",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "digest",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "guardian",
            "type": "pubkey"
          },
          {
            "name": "count",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "chainId",
            "type": "u16"
          },
          {
            "name": "guardians",
            "type": {
              "vec": "pubkey"
            }
          },
          {
            "name": "threshold",
            "type": "u8"
          },
          {
            "name": "guardianSet",
            "type": "u32"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "nextNonce",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "consumed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "digest",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "slot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "executed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "digest",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "sourceChain",
            "type": "u16"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "recipient",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "guardiansChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "guardianSet",
            "type": "u32"
          },
          {
            "name": "threshold",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "outbound",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "sourceChain",
            "type": "u16"
          },
          {
            "name": "destChain",
            "type": "u16"
          },
          {
            "name": "destMint",
            "type": "pubkey"
          },
          {
            "name": "sender",
            "type": "pubkey"
          },
          {
            "name": "recipient",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "slot",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "pauseChanged",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "by",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "payload",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "sourceChain",
            "type": "u16"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "destChain",
            "type": "u16"
          },
          {
            "name": "destMint",
            "type": "pubkey"
          },
          {
            "name": "recipient",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "route",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "localMint",
            "type": "pubkey"
          },
          {
            "name": "native",
            "type": "bool"
          },
          {
            "name": "remoteChain",
            "type": "u16"
          },
          {
            "name": "remoteMint",
            "type": "pubkey"
          },
          {
            "name": "dailyCap",
            "type": "u64"
          },
          {
            "name": "windowStart",
            "type": "i64"
          },
          {
            "name": "windowUsed",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "sent",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "sender",
            "type": "pubkey"
          },
          {
            "name": "localMint",
            "type": "pubkey"
          },
          {
            "name": "destChain",
            "type": "u16"
          },
          {
            "name": "destMint",
            "type": "pubkey"
          },
          {
            "name": "recipient",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "digest",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    }
  ]
};
