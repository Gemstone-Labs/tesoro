/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/holdem.json`.
 */
export type Holdem = {
  "address": "CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE",
  "metadata": {
    "name": "holdem",
    "version": "0.1.0",
    "spec": "0.1.0"
  },
  "instructions": [
    {
      "name": "act",
      "docs": [
        "Rollup. A Player acts on their turn."
      ],
      "discriminator": [
        114,
        158,
        229,
        112,
        242,
        50,
        227,
        5
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
          "name": "hole0",
          "writable": true
        },
        {
          "name": "hole1",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "action",
          "type": {
            "defined": {
              "name": "action"
            }
          }
        }
      ]
    },
    {
      "name": "assignMatch",
      "docs": [
        "Base, operator. Binds an Active tesoro_core Match of this Game to a table and its current",
        "epoch, once. The Players and the speed are copied from the Match, the start deadline is",
        "fixed here, and the Match's refund timer is held past the whole table window."
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
      "name": "beginMatch",
      "docs": [
        "Rollup, permissionless. Starts the Assignment's Match on its table: only if the table is",
        "Idle at exactly the assigned epoch with seats, the tesoro_core Match is still Active and a",
        "ring slot is free. Everything about the Match comes from the Assignment, never from the",
        "caller. It only reserves the slot; the Match starts when both Players have checked in."
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
        "Rollup. A Player checks in. When both have, the Match starts: equal Chips, first hand,",
        "blinds posted."
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
      "args": []
    },
    {
      "name": "claimTimeout",
      "docs": [
        "Rollup, permissionless. Once the current deadline has passed: an idle Player is checked",
        "(or folded when facing a bet); missing entropy cancels hand one (no-show, both entries",
        "refunded) or forfeits a later hand; an answer that never comes ends the hand in a refund;",
        "three missed turns in a row forfeit the Match."
      ],
      "discriminator": [
        130,
        234,
        45,
        53,
        120,
        90,
        86,
        178
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
          "name": "hole0",
          "writable": true
        },
        {
          "name": "hole1",
          "writable": true
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
      "name": "contributeEntropy",
      "docs": [
        "Rollup. A Player folds a fresh secret into this hand. It goes into the Player's own Hole",
        "only, and the public table is not written, so the transaction touches nothing both Players",
        "can read. The secret is spent at the deal and may not repeat."
      ],
      "discriminator": [
        226,
        50,
        83,
        148,
        208,
        127,
        106,
        222
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
          "name": "hole",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "secret",
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
      "name": "deal",
      "docs": [
        "Rollup, permissionless. Once the answer is in: derives the seed, draws the nine cards,",
        "writes each Player's hole cards and their shares of the board, zeroes every secret and",
        "half, and opens preflop betting. The seed and the deck are never stored."
      ],
      "discriminator": [
        128,
        0,
        138,
        208,
        72,
        249,
        203,
        239
      ],
      "accounts": [
        {
          "name": "payer",
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
          "name": "hole0",
          "writable": true
        },
        {
          "name": "hole1",
          "writable": true
        }
      ],
      "args": []
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
                174,
                96,
                200,
                103,
                127,
                104,
                62,
                170,
                232,
                90,
                29,
                158,
                38,
                83,
                120,
                138,
                228,
                74,
                166,
                86,
                92,
                73,
                111,
                43,
                52,
                38,
                103,
                98,
                92,
                102,
                245,
                169
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
          "address": "CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE"
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
                174,
                96,
                200,
                103,
                127,
                104,
                62,
                170,
                232,
                90,
                29,
                158,
                38,
                83,
                120,
                138,
                228,
                74,
                166,
                86,
                92,
                73,
                111,
                43,
                52,
                38,
                103,
                98,
                92,
                102,
                245,
                169
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
          "address": "CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE"
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
                174,
                96,
                200,
                103,
                127,
                104,
                62,
                170,
                232,
                90,
                29,
                158,
                38,
                83,
                120,
                138,
                228,
                74,
                166,
                86,
                92,
                73,
                111,
                43,
                52,
                38,
                103,
                98,
                92,
                102,
                245,
                169
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
          "address": "CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE"
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
      "name": "expireStart",
      "docs": [
        "Rollup, permissionless. A table whose Players did not both check in before the start",
        "deadline ends the Match so it can be settled from the ring like any other: the Player who",
        "checked in wins, and if neither did it is a no-show (`table_kit::absence_outcome`)."
      ],
      "discriminator": [
        99,
        133,
        37,
        248,
        47,
        63,
        197,
        37
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
                  174,
                  96,
                  200,
                  103,
                  127,
                  104,
                  62,
                  170,
                  232,
                  90,
                  29,
                  158,
                  38,
                  83,
                  120,
                  138,
                  228,
                  74,
                  166,
                  86,
                  92,
                  73,
                  111,
                  43,
                  52,
                  38,
                  103,
                  98,
                  92,
                  102,
                  245,
                  169
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
          "address": "CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE"
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
        }
      ],
      "args": []
    },
    {
      "name": "initSeats",
      "docs": [
        "Rollup, permissionless, once per table. Creates the two Hole seats as ephemeral accounts",
        "behind private permissions with no member. The table pays the rent. They are never",
        "closed while the table runs."
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
          "name": "hole0",
          "writable": true
        },
        {
          "name": "hole1",
          "writable": true
        },
        {
          "name": "hole0Permission",
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
                "path": "hole0"
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
          "name": "hole1Permission",
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
                "path": "hole1"
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
                  174,
                  96,
                  200,
                  103,
                  127,
                  104,
                  62,
                  170,
                  232,
                  90,
                  29,
                  158,
                  38,
                  83,
                  120,
                  138,
                  228,
                  74,
                  166,
                  86,
                  92,
                  73,
                  111,
                  43,
                  52,
                  38,
                  103,
                  98,
                  92,
                  102,
                  245,
                  169
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
          "address": "CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE"
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
      "name": "requestVrf",
      "docs": [
        "Rollup, permissionless. Asks the oracle for this hand's randomness, once. The program",
        "chooses the input: the table, the Match, the epoch, the hand, the request number and the",
        "hashes of both frozen secrets. The answer is accepted only for this request."
      ],
      "discriminator": [
        5,
        87,
        79,
        152,
        164,
        176,
        190,
        226
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
          "name": "hole0"
        },
        {
          "name": "hole1"
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
        "delay for clients to read the final board. The ring is kept."
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
        "Rollup, operator only. Retires a table's seats: closes both Holes and their permissions",
        "and returns the rent to the table. Only an idle table with blank seats; this is the one",
        "place a seat's history may open, and nothing a Player can call reaches it."
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
          "name": "hole0",
          "writable": true
        },
        {
          "name": "hole1",
          "writable": true
        },
        {
          "name": "hole0Permission",
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
                "path": "hole0"
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
          "name": "hole1Permission",
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
                "path": "hole1"
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
        "Rollup, permissionless. Hands both seats to the Match's Players: each seat must be blank,",
        "then it is stamped with its Player and its permission member is swapped from nobody to",
        "that Player. Only before play begins; never on a Player's call into a live Match."
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
          "name": "hole0",
          "writable": true
        },
        {
          "name": "hole1",
          "writable": true
        },
        {
          "name": "hole0Permission",
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
                "path": "hole0"
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
          "name": "hole1Permission",
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
                "path": "hole1"
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
          "address": "CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE"
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
      "name": "voidTable",
      "docs": [
        "Rollup, permissionless. A table whose Match tesoro_core has already frozen (it refunded,",
        "say after an outage) before the table produced a result is given up: the reserved slot is",
        "freed and the table moves to Over, ready to wipe its seats and reset."
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
      "name": "vrfCallbackShuffle",
      "docs": [
        "Rollup. VRF callback: splits the oracle's output into a half per Hole. Accepted only for",
        "the one outstanding request of the current epoch and hand, named by its marker address,",
        "and only once."
      ],
      "discriminator": [
        143,
        184,
        18,
        167,
        228,
        222,
        176,
        162
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
          "name": "hole0",
          "writable": true
        },
        {
          "name": "hole1",
          "writable": true
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
      "name": "wipeSeats",
      "docs": [
        "Rollup, permissionless. Once the Match is over (or voided): zeroes both seats and swaps",
        "their permission members to nobody, so nothing the Players could read is left and the",
        "seats are never without a private permission. The next `seat_players` hands them on."
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
          "name": "hole0",
          "writable": true
        },
        {
          "name": "hole1",
          "writable": true
        },
        {
          "name": "hole0Permission",
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
                "path": "hole0"
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
          "name": "hole1Permission",
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
                "path": "hole1"
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
      "name": "hole",
      "discriminator": [
        14,
        167,
        116,
        207,
        25,
        217,
        219,
        50
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
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "notAPlayer",
      "msg": "Signer is not a Player of this Match"
    },
    {
      "code": 6001,
      "name": "alreadyContributed",
      "msg": "Entropy already contributed for this hand"
    },
    {
      "code": 6002,
      "name": "entropyIncomplete",
      "msg": "Both Players must contribute entropy and the VRF output must arrive first"
    },
    {
      "code": 6003,
      "name": "alreadyDealt",
      "msg": "The hand is already dealt, or its randomness already requested"
    },
    {
      "code": 6004,
      "name": "overflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6005,
      "name": "invalidSpeed",
      "msg": "Unknown speed"
    },
    {
      "code": 6006,
      "name": "alreadyStarted",
      "msg": "Match already started"
    },
    {
      "code": 6007,
      "name": "notLive",
      "msg": "Match is not live"
    },
    {
      "code": 6008,
      "name": "wrongPhase",
      "msg": "Not valid in this phase of the hand"
    },
    {
      "code": 6009,
      "name": "notYourTurn",
      "msg": "It is not your turn"
    },
    {
      "code": 6010,
      "name": "cannotCheck",
      "msg": "Cannot check facing a bet"
    },
    {
      "code": 6011,
      "name": "nothingToCall",
      "msg": "Nothing to call"
    },
    {
      "code": 6012,
      "name": "opponentAllIn",
      "msg": "The opponent is all-in"
    },
    {
      "code": 6013,
      "name": "raiseTooSmall",
      "msg": "Raise below the minimum"
    },
    {
      "code": 6014,
      "name": "notEnoughChips",
      "msg": "Not enough chips"
    },
    {
      "code": 6015,
      "name": "notTimedOut",
      "msg": "Deadline has not passed"
    },
    {
      "code": 6016,
      "name": "badTesoroMatch",
      "msg": "The tesoro_core Match is not an Active Match of this Game"
    },
    {
      "code": 6017,
      "name": "matchNotOver",
      "msg": "The Match is not over"
    },
    {
      "code": 6018,
      "name": "alreadyFinalized",
      "msg": "Already settled or refunded in tesoro_core"
    },
    {
      "code": 6019,
      "name": "invalidValidator",
      "msg": "Delegation must name the TEE validator"
    },
    {
      "code": 6020,
      "name": "permissionNotReady",
      "msg": "A permission for this account is missing or is not a real permission"
    },
    {
      "code": 6021,
      "name": "notUpgradeAuthority",
      "msg": "Only the upgrade authority may do this"
    },
    {
      "code": 6022,
      "name": "notOperator",
      "msg": "Only the operator may do this"
    },
    {
      "code": 6023,
      "name": "badConfig",
      "msg": "Invalid configuration"
    },
    {
      "code": 6024,
      "name": "badTableSlot",
      "msg": "That table index or generation is not allowed"
    },
    {
      "code": 6025,
      "name": "notAssigned",
      "msg": "The Assignment names another table, generation or epoch"
    },
    {
      "code": 6026,
      "name": "seatsNotOpen",
      "msg": "The seats are not open"
    },
    {
      "code": 6027,
      "name": "seatsOpen",
      "msg": "The seats are already open or still open"
    },
    {
      "code": 6028,
      "name": "seatsMissing",
      "msg": "The table has no seats yet"
    },
    {
      "code": 6029,
      "name": "seatNotBlank",
      "msg": "A seat still holds data from an earlier Match"
    },
    {
      "code": 6030,
      "name": "ringFull",
      "msg": "The result ring is full"
    },
    {
      "code": 6031,
      "name": "noResult",
      "msg": "The ring has no result for this Match and epoch"
    },
    {
      "code": 6032,
      "name": "noReceipt",
      "msg": "The evidence that frees the slot is missing or too recent"
    },
    {
      "code": 6033,
      "name": "badSlot",
      "msg": "The ring slot is not in the state this needs"
    },
    {
      "code": 6034,
      "name": "notDirty",
      "msg": "The table has no result to commit"
    },
    {
      "code": 6035,
      "name": "notCommitted",
      "msg": "The table result has not been committed yet"
    },
    {
      "code": 6036,
      "name": "resetTooEarly",
      "msg": "The table is not ready to be reset"
    },
    {
      "code": 6037,
      "name": "badTable",
      "msg": "Not the table of this Assignment, or not a valid table"
    },
    {
      "code": 6038,
      "name": "badFeeVault",
      "msg": "Not the TEE validator's fee vault"
    },
    {
      "code": 6039,
      "name": "startWindowPassed",
      "msg": "The start deadline has passed"
    },
    {
      "code": 6040,
      "name": "secretReused",
      "msg": "That secret was already used at this seat"
    },
    {
      "code": 6041,
      "name": "staleRequest",
      "msg": "The randomness answer is not for the current request"
    },
    {
      "code": 6042,
      "name": "notUntabled",
      "msg": "That Match is not a joined Match without a table"
    },
    {
      "code": 6043,
      "name": "tableWaitNotOver",
      "msg": "The Match has not waited long enough for a table"
    },
    {
      "code": 6044,
      "name": "cannotSkip",
      "msg": "This Assignment cannot be given up yet, or any more"
    }
  ],
  "types": [
    {
      "name": "action",
      "docs": [
        "A Player's decision. `Raise { to }` is the total bet for the street after the raise (a bet",
        "when nothing is open); `to` equal to the Player's whole stack is an all-in."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "fold"
          },
          {
            "name": "check"
          },
          {
            "name": "call"
          },
          {
            "name": "raise",
            "fields": [
              {
                "name": "to",
                "type": "u64"
              }
            ]
          }
        ]
      }
    },
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
            "name": "speed",
            "docs": [
              "`SPEED_STANDARD` or `SPEED_TURBO`, from the Match's `meta.asset`."
            ],
            "type": "u8"
          },
          {
            "name": "startDeadline",
            "docs": [
              "Unix time by which both Players must have checked in."
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
              "Entry sizes in Gemas, zero-padded. All zero until `set_entry_sizes`: the default ladder",
              "(100 / 500 / 1,000) applies, so an older Config needs no call. Appended after the Leaderboard",
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
        "A delegated lamport reserve the operator empties into the Sponsor inside the rollup (a base",
        "transfer to a delegated account is not seen there)."
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
      "name": "gameMatch",
      "docs": [
        "The public part of a Match, played on a table. Readable by anyone; holds no hidden card."
      ],
      "type": {
        "kind": "struct",
        "fields": [
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
            "name": "speed",
            "type": "u8"
          },
          {
            "name": "status",
            "type": "u8"
          },
          {
            "name": "winner",
            "docs": [
              "Winning seat when `status == STATUS_OVER`, else `NO_WINNER`."
            ],
            "type": "u8"
          },
          {
            "name": "noShow",
            "docs": [
              "Both Players checked in and neither took part in the first hand: a no-show, not a refund."
            ],
            "type": "bool"
          },
          {
            "name": "handNo",
            "type": "u32"
          },
          {
            "name": "dealer",
            "docs": [
              "Seat of the button; in heads-up it posts the small blind and acts first preflop."
            ],
            "type": "u8"
          },
          {
            "name": "phase",
            "type": "u8"
          },
          {
            "name": "smallBlind",
            "type": "u64"
          },
          {
            "name": "bigBlind",
            "type": "u64"
          },
          {
            "name": "stacks",
            "docs": [
              "Chips behind, per seat."
            ],
            "type": {
              "array": [
                "u64",
                2
              ]
            }
          },
          {
            "name": "bets",
            "docs": [
              "Chips put in during the current street."
            ],
            "type": {
              "array": [
                "u64",
                2
              ]
            }
          },
          {
            "name": "committed",
            "docs": [
              "Chips put in during the whole hand."
            ],
            "type": {
              "array": [
                "u64",
                2
              ]
            }
          },
          {
            "name": "toAct",
            "type": "u8"
          },
          {
            "name": "acted",
            "type": {
              "array": [
                "bool",
                2
              ]
            }
          },
          {
            "name": "lastRaise",
            "docs": [
              "Size of the last full raise this street: the minimum next raise."
            ],
            "type": "u64"
          },
          {
            "name": "board",
            "type": {
              "array": [
                "u8",
                5
              ]
            }
          },
          {
            "name": "deadline",
            "type": "i64"
          },
          {
            "name": "extensions",
            "docs": [
              "Times the shuffle clock was extended this hand while both Players were ready."
            ],
            "type": "u8"
          },
          {
            "name": "missed",
            "type": {
              "array": [
                "u8",
                2
              ]
            }
          },
          {
            "name": "lastHandNo",
            "type": "u32"
          },
          {
            "name": "lastResult",
            "docs": [
              "Winning seat of the last hand, or `SPLIT`."
            ],
            "type": "u8"
          },
          {
            "name": "lastPot",
            "type": "u64"
          },
          {
            "name": "lastShowdown",
            "type": "bool"
          },
          {
            "name": "lastShown",
            "docs": [
              "Hole cards shown at the last showdown (`NO_CARD` when not shown)."
            ],
            "type": {
              "array": [
                {
                  "array": [
                    "u8",
                    2
                  ]
                },
                2
              ]
            }
          },
          {
            "name": "lastBoard",
            "type": {
              "array": [
                "u8",
                5
              ]
            }
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
      "name": "hole",
      "docs": [
        "One Player's hidden seat: an ephemeral account (rollup-only, never committed) behind a private",
        "permission, created once with the table and kept for its life. Between Matches the data is",
        "zeroed and the permission's member is swapped to nobody and then to the next Player; the",
        "account and its permission are never closed or left without a private permission while a",
        "Match may be live.",
        "",
        "It holds this Player's own secret and one half of the VRF output until `deal`, then the",
        "Player's two hole cards and their share of each board card. Neither Hole alone says anything",
        "about the board, the shuffle or the other Hole."
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
            "name": "handNo",
            "docs": [
              "The hand the contribution below belongs to."
            ],
            "type": "u32"
          },
          {
            "name": "contributed",
            "type": "bool"
          },
          {
            "name": "secret",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "lastSecretHash",
            "docs": [
              "Hash of the last secret this seat took, to refuse a repeated secret. Zero when wiped."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "halfSet",
            "type": "bool"
          },
          {
            "name": "half",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "extEntropy",
            "docs": [
              "Reserved for entropy a future confidential source may write; mixed into the seed. Zero",
              "today, and no instruction writes it."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "dealt",
            "type": "bool"
          },
          {
            "name": "cards",
            "type": {
              "array": [
                "u8",
                2
              ]
            }
          },
          {
            "name": "shares",
            "docs": [
              "This seat's XOR share of each board card; the two seats' shares combine to the card."
            ],
            "type": {
              "array": [
                "u8",
                5
              ]
            }
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
        "account is ever committed to Solana. Its two `Hole` seats are rollup-only accounts that live as",
        "long as the table does."
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
              "The two Hole seats exist (created once, kept for the table's life)."
            ],
            "type": "bool"
          },
          {
            "name": "seatsOpen",
            "docs": [
              "The seats belong to the current Match's Players."
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
            "name": "checkedIn",
            "type": {
              "array": [
                "bool",
                2
              ]
            }
          },
          {
            "name": "overAt",
            "type": "i64"
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
            "docs": [
              "The number of the latest request."
            ],
            "type": "u64"
          },
          {
            "name": "reqPending",
            "docs": [
              "A VRF request is outstanding."
            ],
            "type": "bool"
          },
          {
            "name": "reqEpoch",
            "type": "u64"
          },
          {
            "name": "reqHand",
            "type": "u32"
          },
          {
            "name": "reqAt",
            "type": "i64"
          },
          {
            "name": "vrfReady",
            "docs": [
              "The answer arrived and waits for `deal`."
            ],
            "type": "bool"
          },
          {
            "name": "game",
            "type": {
              "defined": {
                "name": "gameMatch"
              }
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
    }
  ]
};
