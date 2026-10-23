/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/block_puzzle.json`.
 */
export type BlockPuzzle = {
  "address": "5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj",
  "metadata": {
    "name": "blockPuzzle",
    "version": "0.1.0",
    "spec": "0.1.0"
  },
  "instructions": [
    {
      "name": "assignMatch",
      "docs": [
        "Base, operator. Binds an Active tesoro_core Match of this Game to a table and its current",
        "epoch, once. The Players are copied from the Match, the start deadline is fixed here, and",
        "the Match's refund timer is held past the whole table window. Refused unless the core",
        "deadline leaves room for the start window, every phase and settlement",
        "(`ASSIGN_BUDGET_SECS`)."
      ],
      "discriminator": [
        195,
        128,
        179,
        141,
        148,
        120,
        135,
        51
      ],
      "accounts": [
        {
          "name": "operator",
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
          "name": "tesoroMatch",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  116,
                  99,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "tesoro_match.inner.id.opener",
                "account": "matchState"
              },
              {
                "kind": "account",
                "path": "tesoro_match.inner.id.n",
                "account": "matchState"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                139,
                232,
                217,
                200,
                195,
                196,
                42,
                210,
                40,
                249,
                196,
                130,
                26,
                66,
                171,
                32,
                36,
                239,
                175,
                140,
                108,
                61,
                148,
                110,
                71,
                7,
                159,
                115,
                202,
                186,
                136,
                218
              ]
            }
          }
        },
        {
          "name": "accountA",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "account_a.authority",
                "account": "tesoroAccount"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                139,
                232,
                217,
                200,
                195,
                196,
                42,
                210,
                40,
                249,
                196,
                130,
                26,
                66,
                171,
                32,
                36,
                239,
                175,
                140,
                108,
                61,
                148,
                110,
                71,
                7,
                159,
                115,
                202,
                186,
                136,
                218
              ]
            }
          }
        },
        {
          "name": "accountB",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "account_b.authority",
                "account": "tesoroAccount"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                139,
                232,
                217,
                200,
                195,
                196,
                42,
                210,
                40,
                249,
                196,
                130,
                26,
                66,
                171,
                32,
                36,
                239,
                175,
                140,
                108,
                61,
                148,
                110,
                71,
                7,
                159,
                115,
                202,
                186,
                136,
                218
              ]
            }
          }
        },
        {
          "name": "authority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "assignment",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  105,
                  103,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "tesoroMatch"
              }
            ]
          }
        },
        {
          "name": "tesoroProgram",
          "address": "AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "generation",
          "type": "u16"
        },
        {
          "name": "index",
          "type": "u16"
        },
        {
          "name": "epoch",
          "type": "u64"
        }
      ]
    },
    {
      "name": "begin",
      "docs": [
        "Rollup, the Player. The first instruction once the run has started: copies the Seed from",
        "the Vault into the Player's own Board. Writes nothing public."
      ],
      "discriminator": [
        35,
        150,
        31,
        42,
        98,
        141,
        116,
        108
      ],
      "accounts": [
        {
          "name": "player",
          "signer": true
        },
        {
          "name": "table",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  97,
                  98,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "table.generation",
                "account": "table"
              },
              {
                "kind": "account",
                "path": "table.index",
                "account": "table"
              }
            ]
          }
        },
        {
          "name": "seedVault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "table"
              }
            ]
          }
        },
        {
          "name": "board",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "binding",
          "type": {
            "defined": {
              "name": "binding"
            }
          }
        }
      ]
    },
    {
      "name": "beginMatch",
      "docs": [
        "Rollup, permissionless. Starts the Assignment's Match on its table: only if the table is",
        "Idle at exactly the assigned epoch with seats, the tesoro_core Match is still Active and a",
        "ring slot is free. Everything about the Match comes from the Assignment, never from the",
        "caller. The check-in window runs from here."
      ],
      "discriminator": [
        30,
        230,
        183,
        200,
        11,
        146,
        125,
        126
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "assignment",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  105,
                  103,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "assignment.tesoro_match",
                "account": "assignment"
              }
            ]
          }
        },
        {
          "name": "table",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  97,
                  98,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "table.generation",
                "account": "table"
              },
              {
                "kind": "account",
                "path": "table.index",
                "account": "table"
              }
            ]
          }
        },
        {
          "name": "tesoroMatch",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  116,
                  99,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "tesoro_match.inner.id.opener",
                "account": "matchState"
              },
              {
                "kind": "account",
                "path": "tesoro_match.inner.id.n",
                "account": "matchState"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                139,
                232,
                217,
                200,
                195,
                196,
                42,
                210,
                40,
                249,
                196,
                130,
                26,
                66,
                171,
                32,
                36,
                239,
                175,
                140,
                108,
                61,
                148,
                110,
                71,
                7,
                159,
                115,
                202,
                186,
                136,
                218
              ]
            }
          }
        }
      ],
      "args": []
    },
    {
      "name": "checkIn",
      "docs": [
        "Rollup. A Player checks in: attendance only, no CPI. The second check-in starts the Seed",
        "window."
      ],
      "discriminator": [
        209,
        253,
        4,
        217,
        250,
        241,
        207,
        50
      ],
      "accounts": [
        {
          "name": "player",
          "signer": true
        },
        {
          "name": "table",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  97,
                  98,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "table.generation",
                "account": "table"
              },
              {
                "kind": "account",
                "path": "table.index",
                "account": "table"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "binding",
          "type": {
            "defined": {
              "name": "binding"
            }
          }
        }
      ]
    },
    {
      "name": "close",
      "docs": [
        "Rollup, permissionless. Ends the Match once its window is over (or both runs are over) and",
        "writes the result into the ring slot with both run logs: the outcome table of the spec. A",
        "Match that never ran ends here too: nobody checking in or no Seed refunds, one Player",
        "absent loses to the present one (unless the rollup stalled), a stalled run is void."
      ],
      "discriminator": [
        98,
        165,
        201,
        177,
        108,
        65,
        206,
        96
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "table",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  97,
                  98,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "table.generation",
                "account": "table"
              },
              {
                "kind": "account",
                "path": "table.index",
                "account": "table"
              }
            ]
          }
        },
        {
          "name": "board0"
        },
        {
          "name": "board1"
        }
      ],
      "args": []
    },
    {
      "name": "closeAssignment",
      "docs": [
        "Base, permissionless. Closes an Assignment once tesoro_core has frozen its Match (the",
        "receipt exists) or the Match account is gone; the rent goes back to whoever paid it."
      ],
      "discriminator": [
        180,
        122,
        187,
        197,
        166,
        152,
        1,
        222
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "assignment",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  105,
                  103,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "assignment.tesoro_match",
                "account": "assignment"
              }
            ]
          }
        },
        {
          "name": "payer",
          "writable": true
        },
        {
          "name": "receipt"
        },
        {
          "name": "matchState"
        }
      ],
      "args": []
    },
    {
      "name": "commitTable",
      "docs": [
        "Rollup, permissionless. Commits the finished table to Solana, paid by the Sponsor. The",
        "first commit of a result is owed once (the table is `dirty` until then). A commit can be",
        "lost on its way to base without the rollup noticing, so it may be repeated while the ring",
        "holds a young Done result, with a wait that doubles from two minutes to an hour (see",
        "`table_kit::CommitGuard`); nobody can drain the Sponsor by calling it again and again.",
        "Only the public table is ever committed."
      ],
      "discriminator": [
        136,
        45,
        98,
        44,
        165,
        128,
        228,
        243
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "table",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  97,
                  98,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "table.generation",
                "account": "table"
              },
              {
                "kind": "account",
                "path": "table.index",
                "account": "table"
              }
            ]
          }
        },
        {
          "name": "sponsor",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  112,
                  111,
                  110,
                  115,
                  111,
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "magicFeeVault",
          "writable": true
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        },
        {
          "name": "magicContext",
          "writable": true,
          "address": "MagicContext1111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "createFuel",
      "docs": [
        "Base, operator. Creates a reserve the operator later empties into the Sponsor."
      ],
      "discriminator": [
        82,
        113,
        189,
        193,
        159,
        137,
        154,
        157
      ],
      "accounts": [
        {
          "name": "operator",
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
          "name": "fuel",
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "n",
          "type": "u8"
        },
        {
          "name": "lamports",
          "type": "u64"
        }
      ]
    },
    {
      "name": "createSponsor",
      "docs": [
        "Base, operator. Creates the Sponsor that pays commits; `lamports` is its first balance."
      ],
      "discriminator": [
        13,
        118,
        139,
        130,
        225,
        182,
        191,
        42
      ],
      "accounts": [
        {
          "name": "operator",
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
          "name": "sponsor",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  112,
                  111,
                  110,
                  115,
                  111,
                  114
                ]
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
          "name": "lamports",
          "type": "u64"
        }
      ]
    },
    {
      "name": "createTable",
      "docs": [
        "Base, operator. Creates a table of the current generation, funded for its seats' rent."
      ],
      "discriminator": [
        214,
        142,
        131,
        250,
        242,
        83,
        135,
        185
      ],
      "accounts": [
        {
          "name": "operator",
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
          "name": "table",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  97,
                  98,
                  108,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "generation"
              },
              {
                "kind": "arg",
                "path": "index"
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
          "name": "generation",
          "type": "u16"
        },
        {
          "name": "index",
          "type": "u16"
        }
      ]
    },
    {
      "name": "delegateFuel",
      "docs": [
        "Base, operator. Delegates a fuel reserve."
      ],
      "discriminator": [
        61,
        213,
        181,
        49,
        144,
        165,
        105,
        215
      ],
      "accounts": [
        {
          "name": "operator",
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
          "name": "bufferFuel",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "fuel"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                66,
                252,
                204,
                94,
                191,
                185,
                144,
                147,
                75,
                164,
                208,
                73,
                223,
                102,
                247,
                74,
                128,
                91,
                97,
                170,
                137,
                116,
                64,
                193,
                131,
                225,
                30,
                149,
                223,
                224,
                219,
                26
              ]
            }
          }
        },
        {
          "name": "delegationRecordFuel",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "fuel"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "delegationMetadataFuel",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110,
                  45,
                  109,
                  101,
                  116,
                  97,
                  100,
                  97,
                  116,
                  97
                ]
              },
              {
                "kind": "account",
                "path": "fuel"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "fuel",
          "writable": true
        },
        {
          "name": "validator",
          "optional": true
        },
        {
          "name": "ownerProgram",
          "address": "5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj"
        },
        {
          "name": "delegationProgram",
          "address": "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "n",
          "type": "u8"
        }
      ]
    },
    {
      "name": "delegateSponsor",
      "docs": [
        "Base, operator. Delegates the Sponsor, once."
      ],
      "discriminator": [
        103,
        51,
        15,
        141,
        25,
        188,
        197,
        245
      ],
      "accounts": [
        {
          "name": "operator",
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
          "name": "bufferSponsor",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "sponsor"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                66,
                252,
                204,
                94,
                191,
                185,
                144,
                147,
                75,
                164,
                208,
                73,
                223,
                102,
                247,
                74,
                128,
                91,
                97,
                170,
                137,
                116,
                64,
                193,
                131,
                225,
                30,
                149,
                223,
                224,
                219,
                26
              ]
            }
          }
        },
        {
          "name": "delegationRecordSponsor",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "sponsor"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "delegationMetadataSponsor",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110,
                  45,
                  109,
                  101,
                  116,
                  97,
                  100,
                  97,
                  116,
                  97
                ]
              },
              {
                "kind": "account",
                "path": "sponsor"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "sponsor",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  112,
                  111,
                  110,
                  115,
                  111,
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "validator",
          "optional": true
        },
        {
          "name": "ownerProgram",
          "address": "5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj"
        },
        {
          "name": "delegationProgram",
          "address": "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "delegateTable",
      "docs": [
        "Base, operator. Delegates a table to the TEE validator, once."
      ],
      "discriminator": [
        161,
        66,
        67,
        113,
        58,
        219,
        238,
        170
      ],
      "accounts": [
        {
          "name": "operator",
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
          "name": "bufferTable",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "table"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                66,
                252,
                204,
                94,
                191,
                185,
                144,
                147,
                75,
                164,
                208,
                73,
                223,
                102,
                247,
                74,
                128,
                91,
                97,
                170,
                137,
                116,
                64,
                193,
                131,
                225,
                30,
                149,
                223,
                224,
                219,
                26
              ]
            }
          }
        },
        {
          "name": "delegationRecordTable",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "table"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "delegationMetadataTable",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110,
                  45,
                  109,
                  101,
                  116,
                  97,
                  100,
                  97,
                  116,
                  97
                ]
              },
              {
                "kind": "account",
                "path": "table"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "table",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  97,
                  98,
                  108,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "generation"
              },
              {
                "kind": "arg",
                "path": "index"
              }
            ]
          }
        },
        {
          "name": "validator",
          "optional": true
        },
        {
          "name": "ownerProgram",
          "address": "5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj"
        },
        {
          "name": "delegationProgram",
          "address": "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "generation",
          "type": "u16"
        },
        {
          "name": "index",
          "type": "u16"
        }
      ]
    },
    {
      "name": "finalize",
      "docs": [
        "Base, permissionless. Settles the tesoro_core Match from the result in the committed",
        "table's ring, by CPI signed by this Game's `authority` PDA. Without a result it refunds",
        "only when the table has demonstrably moved past the Assignment's epoch without the Match.",
        "Only starts the settlement in tesoro_core; its chunks follow."
      ],
      "discriminator": [
        171,
        61,
        218,
        56,
        127,
        115,
        12,
        217
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Pays the settlement receipt's rent in tesoro_core."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "assignment",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  105,
                  103,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "assignment.tesoro_match",
                "account": "assignment"
              }
            ]
          }
        },
        {
          "name": "table",
          "docs": [
            "program) and contents are checked in `finalize`."
          ]
        },
        {
          "name": "tesoroMatch",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  116,
                  99,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "tesoro_match.inner.id.opener",
                "account": "matchState"
              },
              {
                "kind": "account",
                "path": "tesoro_match.inner.id.n",
                "account": "matchState"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                139,
                232,
                217,
                200,
                195,
                196,
                42,
                210,
                40,
                249,
                196,
                130,
                26,
                66,
                171,
                32,
                36,
                239,
                175,
                140,
                108,
                61,
                148,
                110,
                71,
                7,
                159,
                115,
                202,
                186,
                136,
                218
              ]
            }
          }
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
            ],
            "program": {
              "kind": "const",
              "value": [
                139,
                232,
                217,
                200,
                195,
                196,
                42,
                210,
                40,
                249,
                196,
                130,
                26,
                66,
                171,
                32,
                36,
                239,
                175,
                140,
                108,
                61,
                148,
                110,
                71,
                7,
                159,
                115,
                202,
                186,
                136,
                218
              ]
            }
          }
        },
        {
          "name": "gameRecord",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  97,
                  109,
                  101
                ]
              },
              {
                "kind": "const",
                "value": [
                  66,
                  252,
                  204,
                  94,
                  191,
                  185,
                  144,
                  147,
                  75,
                  164,
                  208,
                  73,
                  223,
                  102,
                  247,
                  74,
                  128,
                  91,
                  97,
                  170,
                  137,
                  116,
                  64,
                  193,
                  131,
                  225,
                  30,
                  149,
                  223,
                  224,
                  219,
                  26
                ]
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                139,
                232,
                217,
                200,
                195,
                196,
                42,
                210,
                40,
                249,
                196,
                130,
                26,
                66,
                171,
                32,
                36,
                239,
                175,
                140,
                108,
                61,
                148,
                110,
                71,
                7,
                159,
                115,
                202,
                186,
                136,
                218
              ]
            }
          }
        },
        {
          "name": "authority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "gameProgram",
          "address": "5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj"
        },
        {
          "name": "programData"
        },
        {
          "name": "receipt",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  116,
                  116,
                  108,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "tesoroMatch"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                139,
                232,
                217,
                200,
                195,
                196,
                42,
                210,
                40,
                249,
                196,
                130,
                26,
                66,
                171,
                32,
                36,
                239,
                175,
                140,
                108,
                61,
                148,
                110,
                71,
                7,
                159,
                115,
                202,
                186,
                136,
                218
              ]
            }
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "coreEventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                139,
                232,
                217,
                200,
                195,
                196,
                42,
                210,
                40,
                249,
                196,
                130,
                26,
                66,
                171,
                32,
                36,
                239,
                175,
                140,
                108,
                61,
                148,
                110,
                71,
                7,
                159,
                115,
                202,
                186,
                136,
                218
              ]
            }
          }
        },
        {
          "name": "tesoroProgram",
          "address": "AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "initSeats",
      "docs": [
        "Rollup, permissionless, once per table. Creates the two Boards and the Vault as ephemeral",
        "accounts behind private permissions with no member. The table pays the rent. They are",
        "never closed while the table runs."
      ],
      "discriminator": [
        14,
        174,
        114,
        182,
        201,
        101,
        198,
        211
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "table",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  97,
                  98,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "table.generation",
                "account": "table"
              },
              {
                "kind": "account",
                "path": "table.index",
                "account": "table"
              }
            ]
          }
        },
        {
          "name": "board0",
          "writable": true
        },
        {
          "name": "board1",
          "writable": true
        },
        {
          "name": "seedVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "table"
              }
            ]
          }
        },
        {
          "name": "board0Permission",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  114,
                  109,
                  105,
                  115,
                  115,
                  105,
                  111,
                  110,
                  58
                ]
              },
              {
                "kind": "account",
                "path": "board0"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                136,
                161,
                10,
                196,
                33,
                152,
                1,
                214,
                246,
                106,
                29,
                60,
                6,
                152,
                192,
                102,
                169,
                175,
                212,
                217,
                180,
                252,
                231,
                71,
                151,
                141,
                209,
                5,
                168,
                212,
                103,
                82
              ]
            }
          }
        },
        {
          "name": "board1Permission",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  114,
                  109,
                  105,
                  115,
                  115,
                  105,
                  111,
                  110,
                  58
                ]
              },
              {
                "kind": "account",
                "path": "board1"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                136,
                161,
                10,
                196,
                33,
                152,
                1,
                214,
                246,
                106,
                29,
                60,
                6,
                152,
                192,
                102,
                169,
                175,
                212,
                217,
                180,
                252,
                231,
                71,
                151,
                141,
                209,
                5,
                168,
                212,
                103,
                82
              ]
            }
          }
        },
        {
          "name": "seedVaultPermission",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  114,
                  109,
                  105,
                  115,
                  115,
                  105,
                  111,
                  110,
                  58
                ]
              },
              {
                "kind": "account",
                "path": "seedVault"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                136,
                161,
                10,
                196,
                33,
                152,
                1,
                214,
                246,
                106,
                29,
                60,
                6,
                152,
                192,
                102,
                169,
                175,
                212,
                217,
                180,
                252,
                231,
                71,
                151,
                141,
                209,
                5,
                168,
                212,
                103,
                82
              ]
            }
          }
        },
        {
          "name": "permissionProgram",
          "address": "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1"
        },
        {
          "name": "ephemeralVault",
          "writable": true,
          "address": "MagicVau1t999999999999999999999999999999999"
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "play",
      "docs": [
        "Rollup, the Player. Replays 1 to 8 moves on the Player's Board with the engine, and shows",
        "the new score and move count on the public table. Refused from the freeze: send",
        "`play_hidden` then. An illegal move rejects the whole transaction."
      ],
      "discriminator": [
        213,
        157,
        193,
        142,
        228,
        56,
        248,
        150
      ],
      "accounts": [
        {
          "name": "player",
          "signer": true
        },
        {
          "name": "table",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  97,
                  98,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "table.generation",
                "account": "table"
              },
              {
                "kind": "account",
                "path": "table.index",
                "account": "table"
              }
            ]
          }
        },
        {
          "name": "board",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "binding",
          "type": {
            "defined": {
              "name": "binding"
            }
          }
        },
        {
          "name": "expectedCount",
          "type": "u16"
        },
        {
          "name": "moves",
          "type": {
            "vec": {
              "defined": {
                "name": "moveArg"
              }
            }
          }
        }
      ]
    },
    {
      "name": "playHidden",
      "docs": [
        "Rollup, the Player. The same moves, touching only the Player's own Board: the public table",
        "is not an account of this instruction, so nothing public changes. Only from the freeze: a",
        "Player may not hide their score from the opponent while watching the opponent's."
      ],
      "discriminator": [
        173,
        79,
        19,
        218,
        145,
        146,
        247,
        162
      ],
      "accounts": [
        {
          "name": "player",
          "signer": true
        },
        {
          "name": "table",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  97,
                  98,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "table.generation",
                "account": "table"
              },
              {
                "kind": "account",
                "path": "table.index",
                "account": "table"
              }
            ]
          }
        },
        {
          "name": "board",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "binding",
          "type": {
            "defined": {
              "name": "binding"
            }
          }
        },
        {
          "name": "expectedCount",
          "type": "u16"
        },
        {
          "name": "moves",
          "type": {
            "vec": {
              "defined": {
                "name": "moveArg"
              }
            }
          }
        }
      ]
    },
    {
      "name": "processUndelegation",
      "discriminator": [
        196,
        28,
        41,
        206,
        48,
        37,
        51,
        167
      ],
      "accounts": [
        {
          "name": "baseAccount",
          "writable": true
        },
        {
          "name": "buffer",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  110,
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  101,
                  45,
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "baseAccount"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                181,
                183,
                0,
                225,
                242,
                87,
                58,
                192,
                204,
                6,
                34,
                1,
                52,
                74,
                207,
                151,
                184,
                53,
                6,
                235,
                140,
                229,
                25,
                152,
                204,
                98,
                126,
                24,
                147,
                128,
                167,
                62
              ]
            }
          }
        },
        {
          "name": "payer",
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "accountSeeds",
          "type": {
            "vec": "bytes"
          }
        }
      ]
    },
    {
      "name": "refillSponsor",
      "docs": [
        "Rollup, operator. Moves lamports from a fuel reserve into the Sponsor."
      ],
      "discriminator": [
        212,
        210,
        18,
        240,
        37,
        50,
        86,
        2
      ],
      "accounts": [
        {
          "name": "operator",
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
          "name": "fuel",
          "writable": true
        },
        {
          "name": "sponsor",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  112,
                  111,
                  110,
                  115,
                  111,
                  114
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "refundUntabled",
      "docs": [
        "Base, permissionless. Refunds a joined Match that no table was ever assigned to, once it has",
        "waited `TABLE_WAIT_SECS`, by CPI signed by this Game's `authority` PDA. Refused whenever an",
        "Assignment exists for the Match, so it can never touch a Match a table has claimed."
      ],
      "discriminator": [
        86,
        179,
        79,
        68,
        70,
        100,
        97,
        237
      ],
      "accounts": [
        {
          "name": "caller",
          "docs": [
            "Pays the settlement receipt's rent in tesoro_core."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "assignment",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  105,
                  103,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "tesoroMatch"
              }
            ]
          }
        },
        {
          "name": "tesoroMatch",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  97,
                  116,
                  99,
                  104
                ]
              },
              {
                "kind": "account",
                "path": "tesoro_match.inner.id.opener",
                "account": "matchState"
              },
              {
                "kind": "account",
                "path": "tesoro_match.inner.id.n",
                "account": "matchState"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                139,
                232,
                217,
                200,
                195,
                196,
                42,
                210,
                40,
                249,
                196,
                130,
                26,
                66,
                171,
                32,
                36,
                239,
                175,
                140,
                108,
                61,
                148,
                110,
                71,
                7,
                159,
                115,
                202,
                186,
                136,
                218
              ]
            }
          }
        },
        {
          "name": "gameRecord",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  97,
                  109,
                  101
                ]
              },
              {
                "kind": "const",
                "value": [
                  66,
                  252,
                  204,
                  94,
                  191,
                  185,
                  144,
                  147,
                  75,
                  164,
                  208,
                  73,
                  223,
                  102,
                  247,
                  74,
                  128,
                  91,
                  97,
                  170,
                  137,
                  116,
                  64,
                  193,
                  131,
                  225,
                  30,
                  149,
                  223,
                  224,
                  219,
                  26
                ]
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                139,
                232,
                217,
                200,
                195,
                196,
                42,
                210,
                40,
                249,
                196,
                130,
                26,
                66,
                171,
                32,
                36,
                239,
                175,
                140,
                108,
                61,
                148,
                110,
                71,
                7,
                159,
                115,
                202,
                186,
                136,
                218
              ]
            }
          }
        },
        {
          "name": "authority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "gameProgram",
          "address": "5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj"
        },
        {
          "name": "programData"
        },
        {
          "name": "receipt",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  101,
                  116,
                  116,
                  108,
                  101,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "tesoroMatch"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                139,
                232,
                217,
                200,
                195,
                196,
                42,
                210,
                40,
                249,
                196,
                130,
                26,
                66,
                171,
                32,
                36,
                239,
                175,
                140,
                108,
                61,
                148,
                110,
                71,
                7,
                159,
                115,
                202,
                186,
                136,
                218
              ]
            }
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "coreEventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                139,
                232,
                217,
                200,
                195,
                196,
                42,
                210,
                40,
                249,
                196,
                130,
                26,
                66,
                171,
                32,
                36,
                239,
                175,
                140,
                108,
                61,
                148,
                110,
                71,
                7,
                159,
                115,
                202,
                186,
                136,
                218
              ]
            }
          }
        },
        {
          "name": "tesoroProgram",
          "address": "AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": []
    },
    {
      "name": "releaseSlot",
      "docs": [
        "Rollup, permissionless. Frees a Done ring slot once tesoro_core has frozen its Match (the",
        "receipt, read a minute after it was written), or once the Match account itself has been",
        "gone for 15 days. A missing or doubtful read keeps the slot."
      ],
      "discriminator": [
        100,
        59,
        168,
        161,
        243,
        243,
        157,
        33
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "table",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  97,
                  98,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "table.generation",
                "account": "table"
              },
              {
                "kind": "account",
                "path": "table.index",
                "account": "table"
              }
            ]
          }
        },
        {
          "name": "receipt"
        },
        {
          "name": "matchState"
        }
      ],
      "args": [
        {
          "name": "index",
          "type": "u8"
        }
      ]
    },
    {
      "name": "requestSeed",
      "docs": [
        "Rollup, permissionless. Asks the oracle for the Seed's randomness. The program chooses the",
        "input (the Match, table, epoch and request number) and the answer is accepted only for this",
        "request. A request is retried every `SEED_RETRY_SECS` while no answer has come, at most",
        "`MAX_SEED_REQUESTS` times, and never extends the Seed window."
      ],
      "discriminator": [
        162,
        96,
        174,
        50,
        178,
        77,
        115,
        152
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "table",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  97,
                  98,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "table.generation",
                "account": "table"
              },
              {
                "kind": "account",
                "path": "table.index",
                "account": "table"
              }
            ]
          }
        },
        {
          "name": "seedVault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "table"
              }
            ]
          }
        },
        {
          "name": "oracleQueue",
          "writable": true,
          "address": "5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc"
        },
        {
          "name": "programIdentity",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  100,
                  101,
                  110,
                  116,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "vrfProgram",
          "address": "Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz"
        },
        {
          "name": "slotHashes",
          "address": "SysvarS1otHashes111111111111111111111111111"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "resetTable",
      "docs": [
        "Rollup, permissionless. Wipes the finished Match from the public table and moves to the",
        "next epoch. Needs the result committed (`dirty` cleared), the seats wiped and a short",
        "delay for clients to read the final scores. The ring and its logs are kept."
      ],
      "discriminator": [
        190,
        10,
        56,
        248,
        93,
        247,
        245,
        251
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "table",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  97,
                  98,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "table.generation",
                "account": "table"
              },
              {
                "kind": "account",
                "path": "table.index",
                "account": "table"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "retireSeats",
      "docs": [
        "Rollup, operator only. Retires a table's seats: closes both Boards, the Vault and their",
        "permissions and returns the rent to the table. Only an idle table with blank seats; this is",
        "the one place a seat's history may open, and nothing a Player can call reaches it."
      ],
      "discriminator": [
        3,
        235,
        166,
        62,
        151,
        214,
        212,
        197
      ],
      "accounts": [
        {
          "name": "operator",
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
          "name": "table",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  97,
                  98,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "table.generation",
                "account": "table"
              },
              {
                "kind": "account",
                "path": "table.index",
                "account": "table"
              }
            ]
          }
        },
        {
          "name": "board0",
          "writable": true
        },
        {
          "name": "board1",
          "writable": true
        },
        {
          "name": "seedVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "table"
              }
            ]
          }
        },
        {
          "name": "board0Permission",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  114,
                  109,
                  105,
                  115,
                  115,
                  105,
                  111,
                  110,
                  58
                ]
              },
              {
                "kind": "account",
                "path": "board0"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                136,
                161,
                10,
                196,
                33,
                152,
                1,
                214,
                246,
                106,
                29,
                60,
                6,
                152,
                192,
                102,
                169,
                175,
                212,
                217,
                180,
                252,
                231,
                71,
                151,
                141,
                209,
                5,
                168,
                212,
                103,
                82
              ]
            }
          }
        },
        {
          "name": "board1Permission",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  114,
                  109,
                  105,
                  115,
                  115,
                  105,
                  111,
                  110,
                  58
                ]
              },
              {
                "kind": "account",
                "path": "board1"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                136,
                161,
                10,
                196,
                33,
                152,
                1,
                214,
                246,
                106,
                29,
                60,
                6,
                152,
                192,
                102,
                169,
                175,
                212,
                217,
                180,
                252,
                231,
                71,
                151,
                141,
                209,
                5,
                168,
                212,
                103,
                82
              ]
            }
          }
        },
        {
          "name": "seedVaultPermission",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  114,
                  109,
                  105,
                  115,
                  115,
                  105,
                  111,
                  110,
                  58
                ]
              },
              {
                "kind": "account",
                "path": "seedVault"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                136,
                161,
                10,
                196,
                33,
                152,
                1,
                214,
                246,
                106,
                29,
                60,
                6,
                152,
                192,
                102,
                169,
                175,
                212,
                217,
                180,
                252,
                231,
                71,
                151,
                141,
                209,
                5,
                168,
                212,
                103,
                82
              ]
            }
          }
        },
        {
          "name": "permissionProgram",
          "address": "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1"
        },
        {
          "name": "ephemeralVault",
          "writable": true,
          "address": "MagicVau1t999999999999999999999999999999999"
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "seatPlayers",
      "docs": [
        "Rollup, permissionless. Hands both Boards to the Match's Players: each seat must be blank,",
        "then it is stamped with its Player, the Match and the epoch, and its permission member is",
        "swapped from nobody to that Player. Only while the Match is Assigned; never on a Player's",
        "call into a live Match."
      ],
      "discriminator": [
        12,
        38,
        115,
        74,
        25,
        229,
        220,
        62
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "table",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  97,
                  98,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "table.generation",
                "account": "table"
              },
              {
                "kind": "account",
                "path": "table.index",
                "account": "table"
              }
            ]
          }
        },
        {
          "name": "board0",
          "writable": true
        },
        {
          "name": "board1",
          "writable": true
        },
        {
          "name": "seedVault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "table"
              }
            ]
          }
        },
        {
          "name": "board0Permission",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  114,
                  109,
                  105,
                  115,
                  115,
                  105,
                  111,
                  110,
                  58
                ]
              },
              {
                "kind": "account",
                "path": "board0"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                136,
                161,
                10,
                196,
                33,
                152,
                1,
                214,
                246,
                106,
                29,
                60,
                6,
                152,
                192,
                102,
                169,
                175,
                212,
                217,
                180,
                252,
                231,
                71,
                151,
                141,
                209,
                5,
                168,
                212,
                103,
                82
              ]
            }
          }
        },
        {
          "name": "board1Permission",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  114,
                  109,
                  105,
                  115,
                  115,
                  105,
                  111,
                  110,
                  58
                ]
              },
              {
                "kind": "account",
                "path": "board1"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                136,
                161,
                10,
                196,
                33,
                152,
                1,
                214,
                246,
                106,
                29,
                60,
                6,
                152,
                192,
                102,
                169,
                175,
                212,
                217,
                180,
                252,
                231,
                71,
                151,
                141,
                209,
                5,
                168,
                212,
                103,
                82
              ]
            }
          }
        },
        {
          "name": "permissionProgram",
          "address": "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1"
        },
        {
          "name": "ephemeralVault",
          "writable": true,
          "address": "MagicVau1t999999999999999999999999999999999"
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "seedCallback",
      "docs": [
        "Rollup, called by the VRF program only. Stores the Seed in the zero-member Vault if it",
        "answers the one outstanding request of this epoch while the table is Seeding. The output",
        "itself is not kept."
      ],
      "discriminator": [
        232,
        222,
        68,
        43,
        128,
        141,
        0,
        65
      ],
      "accounts": [
        {
          "name": "vrfProgramIdentity",
          "docs": [
            "Scoped VRF identity PDA, bound to this program. Its presence as a signer proves",
            "the callback was issued by the VRF program for this program."
          ],
          "signer": true
        },
        {
          "name": "table",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  97,
                  98,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "table.generation",
                "account": "table"
              },
              {
                "kind": "account",
                "path": "table.index",
                "account": "table"
              }
            ]
          }
        },
        {
          "name": "seedVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "table"
              }
            ]
          }
        },
        {
          "name": "request",
          "docs": [
            "one outstanding request. The account itself need not exist."
          ]
        }
      ],
      "args": [
        {
          "name": "randomness",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "setConfig",
      "docs": [
        "Base, upgrade authority only. Names the operator, the current table generation (which may",
        "only rise) and how many tables a generation may have."
      ],
      "discriminator": [
        108,
        158,
        154,
        175,
        212,
        98,
        52,
        66
      ],
      "accounts": [
        {
          "name": "authority",
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
          "address": "5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj"
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
          "name": "operator",
          "type": "pubkey"
        },
        {
          "name": "generation",
          "type": "u16"
        },
        {
          "name": "maxTables",
          "type": "u16"
        }
      ]
    },
    {
      "name": "skipEpoch",
      "docs": [
        "Rollup, permissionless. Gives up an Assignment whose Match never began: the table is Idle at",
        "the Assignment's epoch and the start window has passed, so `begin_match` can never accept it.",
        "Writes a Draw for it into the ring (the way `expire_start` writes one) and marks the table",
        "for a commit, so `finalize` refunds the Match from a committed result without waiting for the",
        "table's next Match. The epoch is untouched, so a later Assignment for it can still begin. At",
        "most once per Match (the ring refuses a second slot)."
      ],
      "discriminator": [
        188,
        198,
        173,
        71,
        75,
        24,
        224,
        183
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "assignment",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  97,
                  115,
                  115,
                  105,
                  103,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "assignment.tesoro_match",
                "account": "assignment"
              }
            ]
          }
        },
        {
          "name": "table",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  97,
                  98,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "table.generation",
                "account": "table"
              },
              {
                "kind": "account",
                "path": "table.index",
                "account": "table"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "start",
      "docs": [
        "Rollup, permissionless. Sets the one shared clock once both have checked in and the Seed",
        "is in: the run begins `GET_READY_SECS` from now. Reveals nothing."
      ],
      "discriminator": [
        62,
        15,
        117,
        236,
        47,
        1,
        89,
        139
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "table",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  97,
                  98,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "table.generation",
                "account": "table"
              },
              {
                "kind": "account",
                "path": "table.index",
                "account": "table"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "voidTable",
      "docs": [
        "Rollup, permissionless. A table whose Match tesoro_core has already frozen (it refunded,",
        "say after an outage) before the table produced a result is given up: the reserved slot is",
        "freed and the table moves to Closed, ready to wipe its seats and reset."
      ],
      "discriminator": [
        79,
        183,
        225,
        24,
        240,
        49,
        250,
        149
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "table",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  97,
                  98,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "table.generation",
                "account": "table"
              },
              {
                "kind": "account",
                "path": "table.index",
                "account": "table"
              }
            ]
          }
        },
        {
          "name": "receipt"
        },
        {
          "name": "matchState"
        }
      ],
      "args": []
    },
    {
      "name": "wipeSeats",
      "docs": [
        "Rollup, permissionless. Once the Match is closed (or voided): zeroes both Boards and the",
        "Vault and swaps the Boards' permission members to nobody, so nothing the Players could",
        "read is left and the seats are never without a private permission. The next",
        "`seat_players` hands them on."
      ],
      "discriminator": [
        80,
        156,
        240,
        63,
        232,
        138,
        47,
        47
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "table",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  97,
                  98,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "table.generation",
                "account": "table"
              },
              {
                "kind": "account",
                "path": "table.index",
                "account": "table"
              }
            ]
          }
        },
        {
          "name": "board0",
          "writable": true
        },
        {
          "name": "board1",
          "writable": true
        },
        {
          "name": "seedVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "table"
              }
            ]
          }
        },
        {
          "name": "board0Permission",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  114,
                  109,
                  105,
                  115,
                  115,
                  105,
                  111,
                  110,
                  58
                ]
              },
              {
                "kind": "account",
                "path": "board0"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                136,
                161,
                10,
                196,
                33,
                152,
                1,
                214,
                246,
                106,
                29,
                60,
                6,
                152,
                192,
                102,
                169,
                175,
                212,
                217,
                180,
                252,
                231,
                71,
                151,
                141,
                209,
                5,
                168,
                212,
                103,
                82
              ]
            }
          }
        },
        {
          "name": "board1Permission",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  114,
                  109,
                  105,
                  115,
                  115,
                  105,
                  111,
                  110,
                  58
                ]
              },
              {
                "kind": "account",
                "path": "board1"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                136,
                161,
                10,
                196,
                33,
                152,
                1,
                214,
                246,
                106,
                29,
                60,
                6,
                152,
                192,
                102,
                169,
                175,
                212,
                217,
                180,
                252,
                231,
                71,
                151,
                141,
                209,
                5,
                168,
                212,
                103,
                82
              ]
            }
          }
        },
        {
          "name": "permissionProgram",
          "address": "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1"
        },
        {
          "name": "ephemeralVault",
          "writable": true,
          "address": "MagicVau1t999999999999999999999999999999999"
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "assignment",
      "discriminator": [
        106,
        201,
        110,
        51,
        89,
        170,
        73,
        31
      ]
    },
    {
      "name": "board",
      "discriminator": [
        79,
        48,
        160,
        63,
        153,
        132,
        240,
        56
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
      "name": "fuel",
      "discriminator": [
        5,
        57,
        10,
        107,
        149,
        19,
        213,
        157
      ]
    },
    {
      "name": "gameRecord",
      "discriminator": [
        28,
        157,
        20,
        4,
        219,
        32,
        208,
        147
      ]
    },
    {
      "name": "matchState",
      "discriminator": [
        250,
        209,
        137,
        70,
        235,
        96,
        121,
        216
      ]
    },
    {
      "name": "sponsor",
      "discriminator": [
        19,
        128,
        115,
        109,
        118,
        109,
        66,
        213
      ]
    },
    {
      "name": "table",
      "discriminator": [
        34,
        100,
        138,
        97,
        236,
        129,
        230,
        112
      ]
    },
    {
      "name": "tableConfig",
      "discriminator": [
        170,
        18,
        158,
        124,
        72,
        3,
        198,
        193
      ]
    },
    {
      "name": "tesoroAccount",
      "discriminator": [
        50,
        226,
        60,
        36,
        163,
        217,
        197,
        178
      ]
    },
    {
      "name": "vault",
      "discriminator": [
        211,
        8,
        232,
        43,
        2,
        152,
        117,
        119
      ]
    }
  ],
  "events": [
    {
      "name": "sessionSettled",
      "discriminator": [
        127,
        161,
        59,
        136,
        23,
        168,
        191,
        149
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "notAPlayer",
      "msg": "Signer is not a Player of this Block Burst Match"
    },
    {
      "code": 6001,
      "name": "overflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6002,
      "name": "wrongPhase",
      "msg": "Not valid in this phase of the Match"
    },
    {
      "code": 6003,
      "name": "staleBinding",
      "msg": "The instruction names another Match, table generation or epoch"
    },
    {
      "code": 6004,
      "name": "checkInClosed",
      "msg": "The check-in window has ended"
    },
    {
      "code": 6005,
      "name": "alreadyCheckedIn",
      "msg": "Already checked in"
    },
    {
      "code": 6006,
      "name": "seedNotReady",
      "msg": "The Seed is not ready"
    },
    {
      "code": 6007,
      "name": "seedWindowClosed",
      "msg": "The Seed window has ended"
    },
    {
      "code": 6008,
      "name": "seedRequestNotDue",
      "msg": "A Seed request is already waiting, or the requests are used up"
    },
    {
      "code": 6009,
      "name": "staleRequest",
      "msg": "The randomness answer is not for the current request"
    },
    {
      "code": 6010,
      "name": "notStarted",
      "msg": "The run has not started"
    },
    {
      "code": 6011,
      "name": "alreadyBegan",
      "msg": "The run already began for this Player"
    },
    {
      "code": 6012,
      "name": "notBegan",
      "msg": "The Player has not begun the run"
    },
    {
      "code": 6013,
      "name": "runOver",
      "msg": "The run is over for this Player"
    },
    {
      "code": 6014,
      "name": "playWindowClosed",
      "msg": "The play window is closed"
    },
    {
      "code": 6015,
      "name": "frozen",
      "msg": "The scores are hidden now: send the hidden play"
    },
    {
      "code": 6016,
      "name": "notFrozen",
      "msg": "The scores are not hidden yet: send the public play"
    },
    {
      "code": 6017,
      "name": "wrongCount",
      "msg": "The move count differs from the one expected"
    },
    {
      "code": 6018,
      "name": "badBatch",
      "msg": "Submit between 1 and 8 moves"
    },
    {
      "code": 6019,
      "name": "illegalMove",
      "msg": "Illegal move"
    },
    {
      "code": 6020,
      "name": "tooFast",
      "msg": "Moves arrived faster than the pace allows"
    },
    {
      "code": 6021,
      "name": "notClosable",
      "msg": "The Match is not ready to be closed"
    },
    {
      "code": 6022,
      "name": "alreadyFinalized",
      "msg": "Already settled or refunded in tesoro_core"
    },
    {
      "code": 6023,
      "name": "badTesoroMatch",
      "msg": "The tesoro_core Match is not an Active Match of this Game"
    },
    {
      "code": 6024,
      "name": "matchNotOver",
      "msg": "The Match is not over"
    },
    {
      "code": 6025,
      "name": "notTimedOut",
      "msg": "Deadline has not passed"
    },
    {
      "code": 6026,
      "name": "invalidValidator",
      "msg": "Delegation must name the TEE validator"
    },
    {
      "code": 6027,
      "name": "notUpgradeAuthority",
      "msg": "Only the upgrade authority may do this"
    },
    {
      "code": 6028,
      "name": "notOperator",
      "msg": "Only the operator may do this"
    },
    {
      "code": 6029,
      "name": "badConfig",
      "msg": "Invalid configuration"
    },
    {
      "code": 6030,
      "name": "badTableSlot",
      "msg": "That table index or generation is not allowed"
    },
    {
      "code": 6031,
      "name": "notAssigned",
      "msg": "The Assignment names another table, generation or epoch"
    },
    {
      "code": 6032,
      "name": "seatsNotOpen",
      "msg": "The seats are not open"
    },
    {
      "code": 6033,
      "name": "seatsOpen",
      "msg": "The seats are already open or still open"
    },
    {
      "code": 6034,
      "name": "seatsMissing",
      "msg": "The table has no seats yet"
    },
    {
      "code": 6035,
      "name": "seatNotBlank",
      "msg": "A seat still holds data from an earlier Match"
    },
    {
      "code": 6036,
      "name": "ringFull",
      "msg": "The result ring is full"
    },
    {
      "code": 6037,
      "name": "noResult",
      "msg": "The ring has no result for this Match and epoch"
    },
    {
      "code": 6038,
      "name": "noReceipt",
      "msg": "The evidence that frees the slot is missing or too recent"
    },
    {
      "code": 6039,
      "name": "badSlot",
      "msg": "The ring slot is not in the state this needs"
    },
    {
      "code": 6040,
      "name": "notDirty",
      "msg": "The table has no result to commit"
    },
    {
      "code": 6041,
      "name": "notCommitted",
      "msg": "The table result has not been committed yet"
    },
    {
      "code": 6042,
      "name": "resetTooEarly",
      "msg": "The table is not ready to be reset"
    },
    {
      "code": 6043,
      "name": "badTable",
      "msg": "Not the table of this Assignment, or not a valid table"
    },
    {
      "code": 6044,
      "name": "badFeeVault",
      "msg": "Not the TEE validator's fee vault"
    },
    {
      "code": 6045,
      "name": "startWindowPassed",
      "msg": "The start deadline has passed"
    },
    {
      "code": 6046,
      "name": "budgetTooShort",
      "msg": "The Block Burst Match cannot finish inside the core deadline"
    },
    {
      "code": 6047,
      "name": "notUntabled",
      "msg": "That Match is not a joined Match without a table"
    },
    {
      "code": 6048,
      "name": "tableWaitNotOver",
      "msg": "The Match has not waited long enough for a table"
    },
    {
      "code": 6049,
      "name": "cannotSkip",
      "msg": "This Assignment cannot be given up yet, or any more"
    }
  ],
  "types": [
    {
      "name": "assignment",
      "docs": [
        "The write-once binding of one tesoro_core Match to one table and one epoch. Created on base by",
        "the operator, read by the table in the rollup and by `finalize` on base."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "tesoroMatch",
            "type": "pubkey"
          },
          {
            "name": "generation",
            "type": "u16"
          },
          {
            "name": "index",
            "type": "u16"
          },
          {
            "name": "epoch",
            "type": "u64"
          },
          {
            "name": "players",
            "docs": [
              "Seat 0 opened the tesoro_core Match, seat 1 joined (the Players' authorities)."
            ],
            "type": {
              "array": [
                "pubkey",
                2
              ]
            }
          },
          {
            "name": "startDeadline",
            "docs": [
              "Unix time by which the Match must have begun on the table."
            ],
            "type": "i64"
          },
          {
            "name": "payer",
            "docs": [
              "Who paid this account's rent; it goes back there when the Assignment is closed."
            ],
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "binding",
      "docs": [
        "What a Player's instruction names. The program refuses any mismatch, which makes a",
        "transaction held back from an earlier Match worthless in a later one on the same table."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "tesoroMatch",
            "type": "pubkey"
          },
          {
            "name": "generation",
            "type": "u16"
          },
          {
            "name": "epoch",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "board",
      "docs": [
        "One Player's hidden seat: an ephemeral account (rollup-only, never committed) behind a private",
        "permission, created once with the table and kept for its life. Between Matches the data is",
        "zeroed and the permission's member swapped to nobody and then to the next Player.",
        "",
        "It holds the Player's board, the Seed (from `begin`), the true score and move count, and the",
        "move log with the landing slot of every move."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "table",
            "type": "pubkey"
          },
          {
            "name": "seat",
            "type": "u8"
          },
          {
            "name": "player",
            "docs": [
              "The Player who may read this seat now; default while the seat is wiped."
            ],
            "type": "pubkey"
          },
          {
            "name": "tesoroMatch",
            "docs": [
              "The Match and epoch the seat was handed over for."
            ],
            "type": "pubkey"
          },
          {
            "name": "epoch",
            "type": "u64"
          },
          {
            "name": "began",
            "type": "bool"
          },
          {
            "name": "seed",
            "type": "u64"
          },
          {
            "name": "occ",
            "type": "u64"
          },
          {
            "name": "gems",
            "type": "u64"
          },
          {
            "name": "score",
            "type": "u32"
          },
          {
            "name": "moves",
            "type": "u16"
          },
          {
            "name": "used",
            "type": "u8"
          },
          {
            "name": "over",
            "type": "bool"
          },
          {
            "name": "lastSlot",
            "docs": [
              "Slot and clock of `begin` or of the latest `play`, for the outage rule."
            ],
            "type": "u64"
          },
          {
            "name": "lastTs",
            "type": "i64"
          },
          {
            "name": "stalled",
            "docs": [
              "The rollup stalled between two of this Player's transactions."
            ],
            "type": "bool"
          },
          {
            "name": "log",
            "docs": [
              "Packed moves (`pack_move`)."
            ],
            "type": {
              "array": [
                "u8",
                120
              ]
            }
          },
          {
            "name": "offsets",
            "docs": [
              "Per move: slots from `start_slot` to the transaction that carried it, little-endian u16."
            ],
            "type": {
              "array": [
                "u8",
                240
              ]
            }
          }
        ]
      }
    },
    {
      "name": "commitGuard",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "tries",
            "docs": [
              "Commits sent since the last result landed."
            ],
            "type": "u8"
          },
          {
            "name": "lastAt",
            "docs": [
              "Rollup time of the latest one."
            ],
            "type": "i64"
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
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "oracleAuthority",
            "docs": [
              "Trusted for now to supply the issuance price and `YieldAccrued`/`PositionLocked` facts.",
              "This is the seam for the LayerZero receiver (messages) and Pyth (price)."
            ],
            "type": "pubkey"
          },
          {
            "name": "platformBps",
            "type": "u16"
          },
          {
            "name": "platformRecipient",
            "docs": [
              "`TesoroAccount` that receives the Platform Fee."
            ],
            "type": "pubkey"
          },
          {
            "name": "legacyGames",
            "docs": [
              "Unused since the per-Game records; its bytes stay so older accounts keep their layout."
            ],
            "type": {
              "vec": {
                "defined": {
                  "name": "legacyGameEntry"
                }
              }
            }
          },
          {
            "name": "leaderboardBps",
            "docs": [
              "Leaderboard Fee in basis points of the Pot. Appended after `games`: an account created",
              "before it reads the fields as zero (the unused tail of the account is zeroed) and is",
              "extended by `init_leaderboard`."
            ],
            "type": "u16"
          },
          {
            "name": "poolAccount",
            "docs": [
              "The Leaderboard Pool: `TesoroAccount` owned by the `[\"leaderboard\"]` address. Zero until",
              "`init_leaderboard`; the fee is off while it is."
            ],
            "type": "pubkey"
          },
          {
            "name": "leaderboardSince",
            "docs": [
              "Unix time `init_leaderboard` first ran: Matches opened before it were not charged the fee, so",
              "readers show the fee only for Matches opened at or after it. Zero until then."
            ],
            "type": "i64"
          },
          {
            "name": "entrySizes",
            "docs": [
              "Entry sizes in Gemas, zero-padded. All zero until `set_entry_sizes`: the default 500 /",
              "1,000 / 2,500 apply, so an older Config needs no call. Appended after the Leaderboard",
              "fields: an account created before reads them as zero from its zeroed tail."
            ],
            "type": {
              "array": [
                "u64",
                4
              ]
            }
          },
          {
            "name": "oracleLocked",
            "docs": [
              "Set by the admin on mainnet (`set_oracle_lock`): the oracle key can no longer register",
              "Positions, report their yield or name an Advance's price (test-mode paths), so a stolen",
              "oracle key cannot mint Gemas. Appended last: an older Config reads it as false."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "fuel",
      "docs": [
        "A delegated lamport reserve the operator empties into the Sponsor inside the rollup."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "n",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "gameRecord",
      "docs": [
        "One Game. Registered once by whoever controls its program (see `registry`); changed only by",
        "that same control, after `GAME_CHANGE_DELAY_SECS`. Listing is written by the admin."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "game",
            "docs": [
              "The Game program's id."
            ],
            "type": "pubkey"
          },
          {
            "name": "settleAuthority",
            "docs": [
              "Only this key may settle the Game's Matches (a PDA of the Game program, or a server key)."
            ],
            "type": "pubkey"
          },
          {
            "name": "studioBps",
            "type": "u16"
          },
          {
            "name": "studioRecipient",
            "docs": [
              "`TesoroAccount` that receives the Studio Fee."
            ],
            "type": "pubkey"
          },
          {
            "name": "pendingAt",
            "docs": [
              "Unix time a proposed change was made; zero while none is waiting."
            ],
            "type": "i64"
          },
          {
            "name": "pendingBy",
            "docs": [
              "The control key that proposed it. Applying needs the same key to be in control still."
            ],
            "type": "pubkey"
          },
          {
            "name": "pendingSettleAuthority",
            "type": "pubkey"
          },
          {
            "name": "pendingStudioBps",
            "type": "u16"
          },
          {
            "name": "pendingStudioRecipient",
            "type": "pubkey"
          },
          {
            "name": "listedUntil",
            "docs": [
              "The Game counts as listed until this unix time (admin). Zero: never listed."
            ],
            "type": "i64"
          },
          {
            "name": "approvedSlot",
            "docs": [
              "The deploy slot the admin approved. A program upgraded since has a different slot and",
              "counts as unlisted until the admin approves again."
            ],
            "type": "u64"
          },
          {
            "name": "approvedHash",
            "docs": [
              "SHA-256 of the approved build's executable bytes without trailing zeros (`registry::code_hash`).",
              "A moved slot keeps the listing only through `refresh_listing`, which proves the bytes are these."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "listingEpoch",
            "docs": [
              "Counts the builds the admin approved: bumped by `list_game` only when it sets a different",
              "hash, never by `refresh_listing`. A Match remembers the epoch it opened under, so a moved",
              "deploy slot with the same epoch is the same build."
            ],
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "legacyGameEntry",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "game",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "studioBps",
            "type": "u16"
          },
          {
            "name": "studioRecipient",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "matchId",
      "docs": [
        "A Match id: the opener's Account and its counter value. Never reused: the counter only grows",
        "and Accounts can't be closed and re-created."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "opener",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "n",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "matchMeta",
      "docs": [
        "What a Match carries explicitly now that the id is only a counter."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "challenge",
            "type": "bool"
          },
          {
            "name": "asset",
            "type": "u8"
          },
          {
            "name": "listed",
            "docs": [
              "The Game's listed status when the Match opened (an unlisted Game earns no Points)."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "matchRecord",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": {
              "defined": {
                "name": "matchId"
              }
            }
          },
          {
            "name": "meta",
            "type": {
              "defined": {
                "name": "matchMeta"
              }
            }
          },
          {
            "name": "game",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "settleAuthority",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "deploySlot",
            "docs": [
              "The Game program's deploy slot when the Match opened."
            ],
            "type": "u64"
          },
          {
            "name": "terms",
            "type": {
              "defined": {
                "name": "terms"
              }
            }
          },
          {
            "name": "entry",
            "type": "u64"
          },
          {
            "name": "openedAt",
            "type": "i64"
          },
          {
            "name": "deadline",
            "docs": [
              "After this time anyone may refund the Match as abandoned (extendable, never past the",
              "absolute deadline)."
            ],
            "type": "i64"
          },
          {
            "name": "deadlineAbs",
            "docs": [
              "Settlement must start before this; fixed at open."
            ],
            "type": "i64"
          },
          {
            "name": "a",
            "type": {
              "defined": {
                "name": "party"
              }
            }
          },
          {
            "name": "b",
            "type": {
              "option": {
                "defined": {
                  "name": "party"
                }
              }
            }
          },
          {
            "name": "potLines",
            "docs": [
              "Lines each side's Pot held when it was put in (the Pot never gains lines)."
            ],
            "type": {
              "array": [
                "u32",
                2
              ]
            }
          },
          {
            "name": "stage",
            "type": {
              "defined": {
                "name": "stage"
              }
            }
          },
          {
            "name": "run",
            "type": {
              "option": {
                "defined": {
                  "name": "run"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "matchState",
      "docs": [
        "A Match. The Pots (the Tickets' lines) live in the two Ticket accounts named in `pots`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "inner",
            "type": {
              "defined": {
                "name": "matchRecord"
              }
            }
          },
          {
            "name": "listed",
            "docs": [
              "The Game was listed when the Match opened: only then does a win earn Points."
            ],
            "type": "bool"
          },
          {
            "name": "listingEpoch",
            "docs": [
              "`GameRecord.listing_epoch` when the Match opened."
            ],
            "type": "u32"
          },
          {
            "name": "payer",
            "docs": [
              "Who paid the rent of this account; it goes back there when the Match is closed."
            ],
            "type": "pubkey"
          },
          {
            "name": "pots",
            "docs": [
              "The Ticket account that is each side's Pot (the default key until the side joined)."
            ],
            "type": {
              "array": [
                "pubkey",
                2
              ]
            }
          },
          {
            "name": "room",
            "docs": [
              "Slots held in Accounts' stores for the lines this Match will credit (`room_reserved` of",
              "each spill counts them). Every credit that takes a new slot pays the holder's share down;",
              "`close_match` hands back what is left."
            ],
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "roomHold"
                  }
                },
                5
              ]
            }
          }
        ]
      }
    },
    {
      "name": "moveArg",
      "docs": [
        "What a Player's move looks like in an instruction."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "piece",
            "type": "u16"
          },
          {
            "name": "x",
            "type": "u8"
          },
          {
            "name": "y",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "party",
      "docs": [
        "One entrant. `funder == player` unless the entry is Backed; then `share_bps` is the Player's",
        "share of the surplus from the accepted Offer."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "player",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "funder",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "shareBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "phase",
      "docs": [
        "A phase of a run. A Win is `Cuts(loser) -> Back(winner) -> Surplus`, a No-show is",
        "`Cuts(0) -> Cuts(1) -> Back(0) -> Back(1)`, a refund is `Back(0) [-> Back(1)]`."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "cuts",
            "fields": [
              "u8"
            ]
          },
          {
            "name": "back",
            "fields": [
              "u8"
            ]
          },
          {
            "name": "surplus",
            "fields": [
              {
                "name": "from",
                "type": "u8"
              },
              {
                "name": "to",
                "type": "u8"
              }
            ]
          }
        ]
      }
    },
    {
      "name": "receipt",
      "docs": [
        "The settlement receipt written when the Match enters Settling or Refunding: the outcome is",
        "frozen in core from then on. Tables read its existence as proof their result slot is spent."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "id",
            "type": {
              "defined": {
                "name": "matchId"
              }
            }
          },
          {
            "name": "kind",
            "type": {
              "defined": {
                "name": "runKind"
              }
            }
          },
          {
            "name": "at",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "ring",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "slots",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "slot"
                  }
                },
                8
              ]
            }
          }
        ]
      }
    },
    {
      "name": "roomHold",
      "docs": [
        "Slots of one Account's stores held for a Match."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "account",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "left",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "run",
      "docs": [
        "The frozen plan and its cursor. Fixed size: it does not grow with the Pot, so the Match record",
        "stays one small account whatever the number of lines. Which line a fee is cut from is not",
        "listed up front: the cut walks the loser's Pot lines in order from the cursor, which only moves",
        "forward, so a replayed or interleaved chunk continues exactly where the last one stopped."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "kind",
            "type": {
              "defined": {
                "name": "runKind"
              }
            }
          },
          {
            "name": "receipt",
            "type": {
              "defined": {
                "name": "receipt"
              }
            }
          },
          {
            "name": "fees",
            "docs": [
              "Platform, Studio, Leaderboard totals in Gemas (a No-show: Platform only, both sides)."
            ],
            "type": {
              "array": [
                "u64",
                3
              ]
            }
          },
          {
            "name": "phases",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "phase"
                  }
                },
                4
              ]
            }
          },
          {
            "name": "nPhases",
            "type": "u8"
          },
          {
            "name": "phaseI",
            "type": "u8"
          },
          {
            "name": "lineI",
            "type": "u32"
          },
          {
            "name": "cutLeft",
            "docs": [
              "Fee Gemas still to cut from each side's lines, per class."
            ],
            "type": {
              "array": [
                {
                  "array": [
                    "u64",
                    3
                  ]
                },
                2
              ]
            }
          },
          {
            "name": "playerLeft",
            "docs": [
              "Gemas of the surplus still owed to the Player (Backed winner), frozen at the start."
            ],
            "type": "u64"
          },
          {
            "name": "chunks",
            "type": "u32"
          },
          {
            "name": "steps",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "runKind",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "win",
            "fields": [
              {
                "name": "winner",
                "type": "u8"
              }
            ]
          },
          {
            "name": "noShow"
          },
          {
            "name": "draw"
          },
          {
            "name": "cancelled"
          },
          {
            "name": "abandoned"
          },
          {
            "name": "gameUpgraded"
          },
          {
            "name": "byGame"
          }
        ]
      }
    },
    {
      "name": "runLog",
      "docs": [
        "The moves of a finished Match, kept in the ring entry of its result until tesoro_core has",
        "frozen the Match. Public once the Match is over. `moves` and `offsets` hold both seats,",
        "seat 0 first: a seat's moves are `pack_move` bytes, its offsets are slot counts from",
        "`start_slot` (two bytes little-endian each) for the transaction that carried the move."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "engineVersion",
            "type": "u8"
          },
          {
            "name": "seed",
            "docs": [
              "The Seed both Players played, public once the Match is over."
            ],
            "type": "u64"
          },
          {
            "name": "seedHash",
            "docs": [
              "SHA-256 over the Seed, the Match, the epoch and the engine version."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "startSlot",
            "type": "u64"
          },
          {
            "name": "reason",
            "docs": [
              "Why the Match ended (`REASON_*`)."
            ],
            "type": "u8"
          },
          {
            "name": "scores",
            "type": {
              "array": [
                "u32",
                2
              ]
            }
          },
          {
            "name": "counts",
            "type": {
              "array": [
                "u16",
                2
              ]
            }
          },
          {
            "name": "moves",
            "type": {
              "array": [
                "u8",
                240
              ]
            }
          },
          {
            "name": "offsets",
            "type": {
              "array": [
                "u8",
                480
              ]
            }
          }
        ]
      }
    },
    {
      "name": "sessionSettled",
      "docs": [
        "What a finished Match tells the world when `finalize` starts its settlement (event-CPI)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "matchState",
            "type": "pubkey"
          },
          {
            "name": "outcome",
            "docs": [
              "The ring outcome: 1 opener wins, 2 joiner wins, 3 draw (refund), 4 no-show."
            ],
            "type": "u8"
          },
          {
            "name": "reason",
            "docs": [
              "Why (`REASON_*`)."
            ],
            "type": "u8"
          },
          {
            "name": "scores",
            "type": {
              "array": [
                "u32",
                2
              ]
            }
          },
          {
            "name": "counts",
            "type": {
              "array": [
                "u16",
                2
              ]
            }
          }
        ]
      }
    },
    {
      "name": "slot",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "state",
            "type": "u8"
          },
          {
            "name": "matchKey",
            "docs": [
              "The tesoro_core Match this slot belongs to."
            ],
            "type": "pubkey"
          },
          {
            "name": "epoch",
            "docs": [
              "The table epoch the Match ran in."
            ],
            "type": "u64"
          },
          {
            "name": "outcome",
            "type": "u8"
          },
          {
            "name": "at",
            "docs": [
              "Rollup clock when the result was written."
            ],
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "sponsor",
      "docs": [
        "A program-owned lamport holder, delegated once, that pays the commits as the fee payer."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "stage",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "open"
          },
          {
            "name": "active"
          },
          {
            "name": "settling"
          },
          {
            "name": "refunding"
          },
          {
            "name": "closed"
          }
        ]
      }
    },
    {
      "name": "table",
      "docs": [
        "A persistent table. Delegated once and never undelegated in normal running; only this public",
        "account is ever committed to Solana. Its two `Board` seats and the `Vault` are rollup-only",
        "accounts that live as long as the table does."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "generation",
            "type": "u16"
          },
          {
            "name": "index",
            "type": "u16"
          },
          {
            "name": "epoch",
            "docs": [
              "Rises at every reset; a Match is bound to one epoch."
            ],
            "type": "u64"
          },
          {
            "name": "phase",
            "type": "u8"
          },
          {
            "name": "seatsCreated",
            "docs": [
              "The two Boards and the Vault exist (created once, kept for the table's life)."
            ],
            "type": "bool"
          },
          {
            "name": "seatsOpen",
            "docs": [
              "The Boards belong to the current Match's Players."
            ],
            "type": "bool"
          },
          {
            "name": "dirty",
            "docs": [
              "The result is in and not yet committed."
            ],
            "type": "bool"
          },
          {
            "name": "tesoroMatch",
            "docs": [
              "The Match on the table (default key while Idle)."
            ],
            "type": "pubkey"
          },
          {
            "name": "slot",
            "docs": [
              "Its ring slot."
            ],
            "type": "u8"
          },
          {
            "name": "startDeadline",
            "type": "i64"
          },
          {
            "name": "players",
            "docs": [
              "Seat 0 opened the tesoro_core Match, seat 1 joined."
            ],
            "type": {
              "array": [
                "pubkey",
                2
              ]
            }
          },
          {
            "name": "checkedIn",
            "type": {
              "array": [
                "bool",
                2
              ]
            }
          },
          {
            "name": "assignedSlot",
            "docs": [
              "Slot and clock when the Match began on the table."
            ],
            "type": "u64"
          },
          {
            "name": "assignedTs",
            "type": "i64"
          },
          {
            "name": "seedingSlot",
            "docs": [
              "Slot when the second check-in started the Seed window."
            ],
            "type": "u64"
          },
          {
            "name": "vrfNonce",
            "docs": [
              "Counts VRF requests on this table, never reset. The callback of request `n` must name the",
              "address `[\"vrfreq\", table, n]`, so an answer to any other request is refused."
            ],
            "type": "u64"
          },
          {
            "name": "reqNonce",
            "type": "u64"
          },
          {
            "name": "reqPending",
            "type": "bool"
          },
          {
            "name": "reqEpoch",
            "type": "u64"
          },
          {
            "name": "reqSlot",
            "type": "u64"
          },
          {
            "name": "reqCount",
            "type": "u8"
          },
          {
            "name": "seedReady",
            "docs": [
              "The Seed was stored in the Vault. Says nothing about its value."
            ],
            "type": "bool"
          },
          {
            "name": "readySlot",
            "docs": [
              "Slot and clock when `start` set the clock."
            ],
            "type": "u64"
          },
          {
            "name": "readyTs",
            "type": "i64"
          },
          {
            "name": "startSlot",
            "docs": [
              "First slot of the run (`ready_slot` + the get-ready countdown); zero before `start`."
            ],
            "type": "u64"
          },
          {
            "name": "shownScore",
            "docs": [
              "Each seat's last seen score and move count: written by `play` until the freeze, then by",
              "nothing until `close`."
            ],
            "type": {
              "array": [
                "u32",
                2
              ]
            }
          },
          {
            "name": "shownMoves",
            "type": {
              "array": [
                "u16",
                2
              ]
            }
          },
          {
            "name": "overAt",
            "type": "i64"
          },
          {
            "name": "reason",
            "type": "u8"
          },
          {
            "name": "outcome",
            "docs": [
              "Ring outcome code of the result (`OUTCOME_*`), `OUTCOME_NONE` before `close`."
            ],
            "type": "u8"
          },
          {
            "name": "finalScores",
            "type": {
              "array": [
                "u32",
                2
              ]
            }
          },
          {
            "name": "finalMoves",
            "type": {
              "array": [
                "u16",
                2
              ]
            }
          },
          {
            "name": "ring",
            "docs": [
              "Results of finished Matches, kept until tesoro_core has frozen them."
            ],
            "type": {
              "defined": {
                "name": "ring"
              }
            }
          },
          {
            "name": "logs",
            "docs": [
              "The run log of each ring slot, same index."
            ],
            "type": {
              "vec": {
                "defined": {
                  "name": "runLog"
                }
              }
            }
          },
          {
            "name": "commit",
            "docs": [
              "When the table may be committed again if a commit was lost on its way to base."
            ],
            "type": {
              "defined": {
                "name": "commitGuard"
              }
            }
          }
        ]
      }
    },
    {
      "name": "tableConfig",
      "docs": [
        "Game-wide settings. The upgrade authority names the operator (the key that creates tables and",
        "assigns Matches), the current table generation (which may only rise) and the table cap."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "operator",
            "type": "pubkey"
          },
          {
            "name": "generation",
            "type": "u16"
          },
          {
            "name": "maxTables",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "terms",
      "docs": [
        "Fee terms snapshotted when the Match opened. The Leaderboard Fee is read when settling starts."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "platformBps",
            "type": "u16"
          },
          {
            "name": "studioBps",
            "type": "u16"
          },
          {
            "name": "studioOwner",
            "docs": [
              "`None`: Tesoro's own Studio Fee, a Source counter. `Some(account)`: an outside studio,",
              "paid as a fee line in its basket."
            ],
            "type": {
              "option": {
                "array": [
                  "u8",
                  32
                ]
              }
            }
          },
          {
            "name": "studioPriority",
            "docs": [
              "The Game was listed when the Match opened: its Studio Fee is a senior fee class, repaid",
              "right after the Platform Fee. Otherwise it is paid as ordinary won Gemas into the",
              "recipient's basket (`studio_owner` must then be set)."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "tesoroAccount",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "authority",
            "docs": [
              "Solana wallet that controls the Account."
            ],
            "type": "pubkey"
          },
          {
            "name": "evmAddress",
            "docs": [
              "The EVM family address of the Account (zero until set)."
            ],
            "type": {
              "array": [
                "u8",
                20
              ]
            }
          }
        ]
      }
    },
    {
      "name": "vault",
      "docs": [
        "The zero-member hidden account that holds the Seed from the callback until the table is",
        "reset. Nobody can read it; `begin` copies the Seed to a Board once the run has started."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "table",
            "type": "pubkey"
          },
          {
            "name": "ready",
            "type": "bool"
          },
          {
            "name": "seed",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
