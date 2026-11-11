/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/railcar.json`.
 */
export type Railcar = {
  "address": "ExpLHqvPEqbdEze5HaYWmnTsH9SXYa8jkXeuEvjRGzam",
  "metadata": {
    "name": "railcar",
    "version": "0.1.0",
    "spec": "0.1.0"
  },
  "instructions": [
    {
      "name": "bindBrake",
      "docs": [
        "Rollup, anyone, once per seat per ride (a repeat does nothing). Hands Table seat `seat`'s",
        "Brake seat to this ride's Player: created the first time the seat index rides on this",
        "Table, otherwise zeroed and its permission members swapped. The members come from the",
        "Table seat only: the wallet of its core Account and the seat key core recorded. Pages bind",
        "every seat while the draw is asked for, so a binding never marks a Player who means to",
        "Brake; no Brake counts until every seat is bound."
      ],
      "discriminator": [
        231,
        133,
        28,
        175,
        93,
        1,
        244,
        157
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "table",
          "writable": true
        },
        {
          "name": "playerAccount",
          "docs": [
            "The seat's core Account (checked against the Table seat): its wallet becomes a member."
          ]
        },
        {
          "name": "brakeSeat",
          "writable": true
        },
        {
          "name": "brakePermission",
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
                "path": "brakeSeat"
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
      "args": [
        {
          "name": "carNo",
          "type": "u64"
        },
        {
          "name": "seat",
          "type": "u8"
        }
      ]
    },
    {
      "name": "checkDeparture",
      "docs": [
        "Base, anyone. Makes a Boarding car leave when it is due: at once when full; otherwise 30 s",
        "after it first held 5 Players (a step-off never moves that time), with 5 or more aboard,",
        "so a car short of 5 at that time leaves in the call after a 5th boards. Anything else is a",
        "no-op, so a join's transaction can always carry it."
      ],
      "discriminator": [
        131,
        44,
        118,
        96,
        84,
        13,
        243,
        89
      ],
      "accounts": [
        {
          "name": "car",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  97,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "car.car_no",
                "account": "car"
              }
            ]
          }
        },
        {
          "name": "matchState",
          "writable": true
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
                  207,
                  116,
                  100,
                  199,
                  233,
                  218,
                  140,
                  25,
                  191,
                  61,
                  95,
                  208,
                  174,
                  9,
                  123,
                  184,
                  139,
                  117,
                  125,
                  44,
                  90,
                  124,
                  222,
                  31,
                  92,
                  6,
                  35,
                  106,
                  237,
                  196,
                  60,
                  130
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
          "name": "gameProgram",
          "address": "ExpLHqvPEqbdEze5HaYWmnTsH9SXYa8jkXeuEvjRGzam"
        },
        {
          "name": "programData"
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
          "name": "tesoroProgram",
          "address": "AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh"
        }
      ],
      "args": []
    },
    {
      "name": "closeCar",
      "docs": [
        "Base, anyone. Closes a car core has frozen (its receipt exists) or closed (an empty car);",
        "the rent goes back to whoever paid it."
      ],
      "discriminator": [
        215,
        236,
        75,
        124,
        139,
        155,
        83,
        16
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "car",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  97,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "car.car_no",
                "account": "car"
              }
            ]
          }
        },
        {
          "name": "carPayer",
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
        "Rollup, anyone. Commits the Table to base, paid by the Sponsor: a result's first commit,",
        "or a repeat of a commit that may have been lost, with Block Burst's doubling wait while",
        "the result is younger than core's refund window."
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
        "Base, operator. Creates Table `index`, funded for its Vault's rent."
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
                207,
                116,
                100,
                199,
                233,
                218,
                140,
                25,
                191,
                61,
                95,
                208,
                174,
                9,
                123,
                184,
                139,
                117,
                125,
                44,
                90,
                124,
                222,
                31,
                92,
                6,
                35,
                106,
                237,
                196,
                60,
                130
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
          "address": "ExpLHqvPEqbdEze5HaYWmnTsH9SXYa8jkXeuEvjRGzam"
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
                207,
                116,
                100,
                199,
                233,
                218,
                140,
                25,
                191,
                61,
                95,
                208,
                174,
                9,
                123,
                184,
                139,
                117,
                125,
                44,
                90,
                124,
                222,
                31,
                92,
                6,
                35,
                106,
                237,
                196,
                60,
                130
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
          "address": "ExpLHqvPEqbdEze5HaYWmnTsH9SXYa8jkXeuEvjRGzam"
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
        "Base, operator. Delegates a Table to the TEE validator, once."
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
                207,
                116,
                100,
                199,
                233,
                218,
                140,
                25,
                191,
                61,
                95,
                208,
                174,
                9,
                123,
                184,
                139,
                117,
                125,
                44,
                90,
                124,
                222,
                31,
                92,
                6,
                35,
                106,
                237,
                196,
                60,
                130
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
          "address": "ExpLHqvPEqbdEze5HaYWmnTsH9SXYa8jkXeuEvjRGzam"
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
          "name": "index",
          "type": "u16"
        }
      ]
    },
    {
      "name": "drawCallback",
      "docs": [
        "Rollup, called by the VRF program only. Keeps the output and the ride it gives in the",
        "Vault if it answers the one outstanding request of this car inside the draw window, and",
        "starts the ride clock."
      ],
      "discriminator": [
        126,
        49,
        233,
        52,
        8,
        16,
        174,
        172
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
          "writable": true
        },
        {
          "name": "vault",
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
            "outstanding request. The account itself need not exist."
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
      "name": "finalize",
      "docs": [
        "Base, anyone. Reads base's committed copy of the car's Table and sends core the result, by",
        "CPI signed by Railcar's authority: the places and early refunds, or a full refund. The",
        "Table must name this car and Match, be over, and hold exactly the car's seated Players.",
        "`remaining_accounts`: every seat page of the car. Closes the car (its job is done)."
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
          "name": "car",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  97,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "car.car_no",
                "account": "car"
              }
            ]
          }
        },
        {
          "name": "carPayer",
          "writable": true
        },
        {
          "name": "table",
          "docs": [
            "delegated); its address (from its stored bump), owner and contents are checked in",
            "`finalize`."
          ]
        },
        {
          "name": "matchState",
          "writable": true
        },
        {
          "name": "coreConfig",
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
                  207,
                  116,
                  100,
                  199,
                  233,
                  218,
                  140,
                  25,
                  191,
                  61,
                  95,
                  208,
                  174,
                  9,
                  123,
                  184,
                  139,
                  117,
                  125,
                  44,
                  90,
                  124,
                  222,
                  31,
                  92,
                  6,
                  35,
                  106,
                  237,
                  196,
                  60,
                  130
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
          "address": "ExpLHqvPEqbdEze5HaYWmnTsH9SXYa8jkXeuEvjRGzam"
        },
        {
          "name": "programData"
        },
        {
          "name": "receipt",
          "docs": [
            "`[\"settled\", match]` (deriving it here too would repeat core's bump search)."
          ],
          "writable": true
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
        }
      ],
      "args": []
    },
    {
      "name": "initVault",
      "docs": [
        "Rollup, anyone, once per Table. Creates the Vault as an ephemeral account behind a private",
        "permission with no member; the Table pays its rent. It is never closed while the Table",
        "runs."
      ],
      "discriminator": [
        77,
        79,
        85,
        150,
        33,
        217,
        52,
        106
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "table",
          "writable": true
        },
        {
          "name": "vault",
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
          "name": "vaultPermission",
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
                "path": "vault"
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
      "name": "jump",
      "docs": [
        "Rollup, the Player of Table seat `seat`: the wallet of the seat's core Account or the",
        "seat's key (`tesoro_core::util::acts_for`, as core checks a seat's signer). Before",
        "the Impact slot the Player is off: the Jump takes the next place in the order. At or after",
        "it the Jump does not count: the ride ends with the Player aboard. When the last Player",
        "aboard Jumps, the ride ends then. A Jump that finds the rollup stalled (the outage rule)",
        "voids the ride and is not recorded. `car_no` makes a transaction held back from an earlier",
        "ride worthless on a later one."
      ],
      "discriminator": [
        115,
        18,
        221,
        88,
        166,
        230,
        219,
        32
      ],
      "accounts": [
        {
          "name": "player",
          "docs": [
            "The seat's Player: the wallet of its core Account, or the seat key core recorded for it."
          ],
          "signer": true
        },
        {
          "name": "table",
          "writable": true
        },
        {
          "name": "vault",
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
      "args": [
        {
          "name": "carNo",
          "type": "u64"
        },
        {
          "name": "seat",
          "type": "u8"
        }
      ]
    },
    {
      "name": "openCar",
      "docs": [
        "Base, the opening Player. Opens the next car (core's many-seat open for 500 Gemas, 5 to",
        "100 seats, signed by Railcar's authority) when no car can still take seats. The opener",
        "boards with core's join like everyone else, in the same transaction."
      ],
      "discriminator": [
        174,
        155,
        21,
        91,
        140,
        178,
        34,
        139
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "opener",
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
          "name": "car",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  97,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "config.next_car",
                "account": "railcarConfig"
              }
            ]
          }
        },
        {
          "name": "boardingMatch",
          "docs": [
            "read by hand in `still_boarding`."
          ]
        },
        {
          "name": "matchState",
          "writable": true
        },
        {
          "name": "coreConfig",
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
          "name": "economy",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  99,
                  111,
                  110,
                  111,
                  109,
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
                  207,
                  116,
                  100,
                  199,
                  233,
                  218,
                  140,
                  25,
                  191,
                  61,
                  95,
                  208,
                  174,
                  9,
                  123,
                  184,
                  139,
                  117,
                  125,
                  44,
                  90,
                  124,
                  222,
                  31,
                  92,
                  6,
                  35,
                  106,
                  237,
                  196,
                  60,
                  130
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
          "name": "gameProgram",
          "address": "ExpLHqvPEqbdEze5HaYWmnTsH9SXYa8jkXeuEvjRGzam"
        },
        {
          "name": "programData"
        },
        {
          "name": "openerAccount",
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
                "path": "opener"
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
          "name": "counters",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  117,
                  110,
                  116,
                  101,
                  114,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "openerAccount"
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
          "name": "n",
          "type": "u64"
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
      "name": "requestDraw",
      "docs": [
        "Rollup, anyone. Asks again when no answer came within `DRAW_RETRY_SLOTS`, at most",
        "`MAX_DRAW_REQUESTS` in all, never once the draw is in."
      ],
      "discriminator": [
        22,
        180,
        8,
        81,
        47,
        21,
        86,
        159
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "table",
          "writable": true
        },
        {
          "name": "vault",
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
      "name": "revealRide",
      "docs": [
        "Base, anyone, once per car, after the rollup committed the car's finished ride and before",
        "`finalize` (which waits for it). Publishes the ride for the round history: the draw, every",
        "Brake, and every seat with its Player, Backer, Offer share, Jump and refund",
        "(`RideRevealed`). Checks the committed Table as `finalize` does. `remaining_accounts`:",
        "every seat page of the car."
      ],
      "discriminator": [
        109,
        84,
        197,
        181,
        184,
        126,
        122,
        130
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "car",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  97,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "car.car_no",
                "account": "car"
              }
            ]
          }
        },
        {
          "name": "table"
        },
        {
          "name": "matchState"
        },
        {
          "name": "coreEventAuthority",
          "docs": [
            "webhook and catch-up (which follow tesoro_core) see this transaction."
          ],
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
      "name": "setConfig",
      "docs": [
        "Base, upgrade authority only. Names the operator and the number of Tables; the number is",
        "fixed once the first car opened (a car's Table is `car_no % tables`)."
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
          "address": "ExpLHqvPEqbdEze5HaYWmnTsH9SXYa8jkXeuEvjRGzam"
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
          "name": "tables",
          "type": "u16"
        }
      ]
    },
    {
      "name": "signal",
      "docs": [
        "Rollup, anyone (each open page sends one about every second). Moves the public Tell",
        "stage; from the Impact slot on it ends the ride and commits the Table. A draw that never",
        "came voids the ride once its window is over, and so does a rollup that ran under half",
        "speed for 5 s during the ride (the outage rule, judged before the Impact)."
      ],
      "discriminator": [
        106,
        129,
        52,
        212,
        183,
        190,
        163,
        21
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "table",
          "writable": true
        },
        {
          "name": "vault",
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
      "name": "skipCar",
      "docs": [
        "Rollup, anyone. Passes over the Table's next car when it will never ride: it was closed",
        "(core froze or closed its Match), its Match is gone, or core has frozen it."
      ],
      "discriminator": [
        105,
        209,
        234,
        52,
        167,
        108,
        220,
        188
      ],
      "accounts": [
        {
          "name": "caller",
          "signer": true
        },
        {
          "name": "table",
          "writable": true
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
          "name": "car"
        },
        {
          "name": "matchState"
        },
        {
          "name": "receipt"
        }
      ],
      "args": []
    },
    {
      "name": "startRide",
      "docs": [
        "Rollup, anyone. Puts the Table's next car on it once that car has left: copies its seated",
        "Players from every seat page (remaining accounts) and asks for the draw. A Table whose",
        "last ride is over is reset first, once core has frozen that car (its receipt)."
      ],
      "discriminator": [
        198,
        221,
        145,
        132,
        226,
        85,
        136,
        97
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "table",
          "writable": true
        },
        {
          "name": "vault",
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
          "name": "car",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  97,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "car.car_no",
                "account": "car"
              }
            ]
          }
        },
        {
          "name": "matchState"
        },
        {
          "name": "previousReceipt",
          "docs": [
            "`receipt_at`."
          ]
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
      "name": "tick",
      "docs": [
        "Rollup, the Player of Table seat `seat` (wallet or seat key, as `jump`): a Player page's",
        "signal, about every second, with `brake` = 1 when the Player presses their Brake (a `u8`,",
        "not a `bool`: Borsh's bool decoding branches, so a press would cost one compute unit less). It moves",
        "the public Tells and ends the ride from the Impact slot on, as `signal` does; before that, a",
        "Brake by a Player aboard who has not Braked on this ride sets the slow period's end to",
        "max(now, end) + 5 s. Anything else about the Brake does nothing (no error): a refusal would",
        "tell anyone who simulates the transaction that this Player has Braked. A Brake at or after",
        "the Impact slot ends the ride and does not count."
      ],
      "discriminator": [
        92,
        79,
        44,
        8,
        101,
        80,
        63,
        15
      ],
      "accounts": [
        {
          "name": "player",
          "docs": [
            "The seat's Player: the wallet of its core Account, or the seat key core recorded for it."
          ],
          "signer": true
        },
        {
          "name": "table",
          "writable": true
        },
        {
          "name": "vault",
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
          "name": "brakeSeat",
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
      "args": [
        {
          "name": "carNo",
          "type": "u64"
        },
        {
          "name": "seat",
          "type": "u8"
        },
        {
          "name": "brake",
          "type": "u8"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "brakeSeat",
      "discriminator": [
        35,
        163,
        188,
        179,
        115,
        170,
        226,
        143
      ]
    },
    {
      "name": "car",
      "discriminator": [
        102,
        252,
        242,
        250,
        81,
        44,
        72,
        153
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
      "name": "economyConfig",
      "discriminator": [
        217,
        204,
        127,
        47,
        151,
        223,
        164,
        182
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
      "name": "manySeatMatch",
      "discriminator": [
        9,
        147,
        183,
        140,
        132,
        123,
        76,
        15
      ]
    },
    {
      "name": "railcarConfig",
      "discriminator": [
        45,
        85,
        70,
        242,
        12,
        95,
        223,
        221
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
      "name": "carDeparted",
      "discriminator": [
        147,
        71,
        160,
        148,
        83,
        169,
        116,
        170
      ]
    },
    {
      "name": "carOpened",
      "discriminator": [
        34,
        107,
        81,
        230,
        11,
        104,
        240,
        96
      ]
    },
    {
      "name": "jumped",
      "discriminator": [
        128,
        194,
        141,
        253,
        12,
        146,
        229,
        13
      ]
    },
    {
      "name": "rideOver",
      "discriminator": [
        10,
        214,
        51,
        83,
        189,
        162,
        110,
        157
      ]
    },
    {
      "name": "rideRevealed",
      "discriminator": [
        3,
        184,
        78,
        204,
        79,
        232,
        171,
        176
      ]
    },
    {
      "name": "rideRunning",
      "discriminator": [
        146,
        13,
        101,
        93,
        30,
        140,
        153,
        213
      ]
    },
    {
      "name": "rideStarted",
      "discriminator": [
        62,
        156,
        220,
        95,
        182,
        238,
        0,
        193
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "notUpgradeAuthority",
      "msg": "Only the upgrade authority may do this"
    },
    {
      "code": 6001,
      "name": "notOperator",
      "msg": "Only the operator may do this"
    },
    {
      "code": 6002,
      "name": "badConfig",
      "msg": "Invalid configuration"
    },
    {
      "code": 6003,
      "name": "badTableSlot",
      "msg": "That Table index is not allowed"
    },
    {
      "code": 6004,
      "name": "invalidValidator",
      "msg": "Delegation must name the TEE validator"
    },
    {
      "code": 6005,
      "name": "carBoarding",
      "msg": "A car is still boarding: board it"
    },
    {
      "code": 6006,
      "name": "wrongCar",
      "msg": "Not this Table's next car"
    },
    {
      "code": 6007,
      "name": "notDeparted",
      "msg": "The car has not left"
    },
    {
      "code": 6008,
      "name": "pagesMissing",
      "msg": "A seat page of the car is missing"
    },
    {
      "code": 6009,
      "name": "wrongPhase",
      "msg": "Not valid in this phase of the ride"
    },
    {
      "code": 6010,
      "name": "vaultMissing",
      "msg": "The Table has no Vault yet"
    },
    {
      "code": 6011,
      "name": "vaultExists",
      "msg": "The Table already has its Vault"
    },
    {
      "code": 6012,
      "name": "drawNotDue",
      "msg": "No draw request is due"
    },
    {
      "code": 6013,
      "name": "staleRequest",
      "msg": "The randomness answer is not for the current request"
    },
    {
      "code": 6014,
      "name": "notAPlayer",
      "msg": "Not a Player of this ride, or not this seat"
    },
    {
      "code": 6015,
      "name": "alreadyJumped",
      "msg": "Already off the car"
    },
    {
      "code": 6016,
      "name": "staleBinding",
      "msg": "The instruction names another car"
    },
    {
      "code": 6017,
      "name": "previousNotFrozen",
      "msg": "Core has not frozen the Table's previous car yet"
    },
    {
      "code": 6018,
      "name": "badTable",
      "msg": "Not the car's Table, or the Table has no result for it"
    },
    {
      "code": 6019,
      "name": "seatsDiffer",
      "msg": "The Table's seats differ from the car's"
    },
    {
      "code": 6020,
      "name": "notFrozen",
      "msg": "Core has not frozen this car yet"
    },
    {
      "code": 6021,
      "name": "cannotSkip",
      "msg": "That car may still ride"
    },
    {
      "code": 6022,
      "name": "commitNotDue",
      "msg": "No commit is due"
    },
    {
      "code": 6023,
      "name": "sponsorDry",
      "msg": "The Sponsor cannot pay a commit"
    },
    {
      "code": 6024,
      "name": "overflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6025,
      "name": "notRevealed",
      "msg": "The ride is not revealed yet: send reveal_ride first"
    },
    {
      "code": 6026,
      "name": "alreadyRevealed",
      "msg": "The ride is already revealed"
    }
  ],
  "types": [
    {
      "name": "brakeSeat",
      "docs": [
        "One Table seat's own Brake, readable only by its Player (permission members: the Player's",
        "wallet and seat key). Rollup-only, created the first time the seat index rides on its Table,",
        "then zeroed and handed to each ride's Player by `bind_brake` (never closed while the Table",
        "runs: closing publishes its past transactions)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
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
            "name": "bound",
            "docs": [
              "1 once bound to `car_no`."
            ],
            "type": "u8"
          },
          {
            "name": "carNo",
            "type": "u64"
          },
          {
            "name": "used",
            "docs": [
              "1 once the Player has Braked on this ride, at ride ms `press_ms`."
            ],
            "type": "u8"
          },
          {
            "name": "pressMs",
            "type": "u32"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          }
        ]
      }
    },
    {
      "name": "car",
      "docs": [
        "One car: the core many-seat Match it boards and the Table it rides on. On base, never",
        "delegated; the rollup reads it. Closed once core froze its Match."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "carNo",
            "type": "u64"
          },
          {
            "name": "tesoroMatch",
            "type": "pubkey"
          },
          {
            "name": "table",
            "type": "u16"
          },
          {
            "name": "tables",
            "docs": [
              "`Config.tables` when the car opened: the car after it on the same Table is",
              "`car_no + tables`."
            ],
            "type": "u16"
          },
          {
            "name": "openedAt",
            "type": "i64"
          },
          {
            "name": "payer",
            "docs": [
              "Who paid this account's rent; it goes back there when the car closes."
            ],
            "type": "pubkey"
          },
          {
            "name": "revealed",
            "docs": [
              "`reveal_ride` published the ride for the round history; `finalize` waits for it."
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "carDeparted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "carNo",
            "type": "u64"
          },
          {
            "name": "tesoroMatch",
            "type": "pubkey"
          },
          {
            "name": "seated",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "carOpened",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "carNo",
            "type": "u64"
          },
          {
            "name": "car",
            "type": "pubkey"
          },
          {
            "name": "tesoroMatch",
            "type": "pubkey"
          },
          {
            "name": "table",
            "type": "u16"
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
      "name": "economyConfig",
      "docs": [
        "Who may do what in the economy upgrade, as explicit settings (never the oracle authority).",
        "Seeds `[\"economy\"]`; created by the admin's `set_economy`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "seasonKeeper",
            "docs": [
              "Runs Seasons (`fund_season_prize`, `record_season`, `pay_season_rank`) besides the admin."
            ],
            "type": "pubkey"
          },
          {
            "name": "fillKeeper",
            "docs": [
              "May fill Instant Redeem orders while `keeper_fills` is on (the admin always may)."
            ],
            "type": "pubkey"
          },
          {
            "name": "keeperFills",
            "docs": [
              "Off by default: only the admin fills."
            ],
            "type": "bool"
          },
          {
            "name": "poolShare",
            "docs": [
              "The Pool's share of every realised Yield Fee, changeable from a Season announced ahead."
            ],
            "type": {
              "defined": {
                "name": "poolShare"
              }
            }
          },
          {
            "name": "routes",
            "docs": [
              "Custodies whose prize escrow `record_season` waits for (zero = unused slot)."
            ],
            "type": {
              "array": [
                "pubkey",
                4
              ]
            }
          },
          {
            "name": "tesoroStudio",
            "docs": [
              "The Account that receives the Studio Fee counters of Tesoro's own Games (`cash_in_fee`);",
              "zero until the admin names it."
            ],
            "type": "pubkey"
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
      "name": "jumped",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "carNo",
            "type": "u64"
          },
          {
            "name": "seat",
            "docs": [
              "The core seat index."
            ],
            "type": "u8"
          },
          {
            "name": "order",
            "type": "u8"
          },
          {
            "name": "rideMs",
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
      "name": "manySeatMatch",
      "docs": [
        "A many-seat Match (ADR 0015) at the same address as a head-to-head one,",
        "`[\"match\", opener Account, n]` with the opener's `next_match`, so its id, overflow records and",
        "receipt work like a head-to-head Match's. Read in place (no Borsh, see `ManySeatRecord`). The",
        "seats are in `SeatPage`s."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "listingEpoch",
            "docs": [
              "`GameRecord.listing_epoch` when the car opened (little endian)."
            ],
            "type": {
              "array": [
                "u8",
                4
              ]
            }
          },
          {
            "name": "payer",
            "docs": [
              "Who paid the rent of this account; it goes back there when the Match is closed."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "inner",
            "type": {
              "defined": {
                "name": "manySeatRecord"
              }
            }
          }
        ]
      }
    },
    {
      "name": "manySeatRecord",
      "docs": [
        "The many-seat Match record (`state::ManySeatMatch`), read and written in place.",
        "",
        "Byte arrays only (alignment 1, no padding), and no Borsh: a record that shared `MatchId`,",
        "`MatchMeta` or `Terms` Borsh code with the head-to-head `MatchState` changed how the",
        "head-to-head settle chunk was compiled (its 12-step worst case rose 24-30 CU), so the",
        "many-seat path keeps its own layout and builds those values through accessors."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "opener",
            "docs": [
              "The id: the opener's Account and its `next_match` (little endian)."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "n",
            "type": {
              "array": [
                "u8",
                8
              ]
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
            "docs": [
              "The Game's settle authority when the car opened: only it departs and settles."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "studioOwner",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "deploySlot",
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "entry",
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "openedAt",
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "deadlineAbs",
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "minSince",
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "firstMinAt",
            "docs": [
              "When `seated` first reached `min_seats`; never cleared (a Game's fixed departure time)."
            ],
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "departedAt",
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "platformBps",
            "type": {
              "array": [
                "u8",
                2
              ]
            }
          },
          {
            "name": "studioBps",
            "type": {
              "array": [
                "u8",
                2
              ]
            }
          },
          {
            "name": "hasStudioOwner",
            "type": "u8"
          },
          {
            "name": "studioPriority",
            "type": "u8"
          },
          {
            "name": "challenge",
            "type": "u8"
          },
          {
            "name": "asset",
            "type": "u8"
          },
          {
            "name": "listed",
            "type": "u8"
          },
          {
            "name": "minSeats",
            "type": "u8"
          },
          {
            "name": "maxSeats",
            "type": "u8"
          },
          {
            "name": "seated",
            "docs": [
              "Seats taken right now."
            ],
            "type": "u8"
          },
          {
            "name": "pages",
            "docs": [
              "Seat pages created so far (always in order, page `pages` is the next one)."
            ],
            "type": "u8"
          },
          {
            "name": "stage",
            "type": "u8"
          },
          {
            "name": "receiptBump",
            "docs": [
              "Canonical bump of the car's receipt `[\"settled\", match]`, found once at open so settling",
              "checks the address with one hash instead of a bump search."
            ],
            "type": "u8"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                5
              ]
            }
          },
          {
            "name": "refundAfter",
            "docs": [
              "From departure: anyone may refund the car from this time on (`settle::start_refund`)."
            ],
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "run",
            "docs": [
              "The run (ticket 03), fixed when settling starts. See `settle`."
            ],
            "type": {
              "defined": {
                "name": "seatRun"
              }
            }
          }
        ]
      }
    },
    {
      "name": "placeSlot",
      "docs": [
        "One place as the run keeps it: who is paid, and how much."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "seat",
            "type": "u8"
          },
          {
            "name": "shareBps",
            "type": {
              "array": [
                "u8",
                2
              ]
            }
          },
          {
            "name": "playerShareBps",
            "docs": [
              "The Player's Offer share of a Backed seat's winnings (0 unbacked)."
            ],
            "type": {
              "array": [
                "u8",
                2
              ]
            }
          },
          {
            "name": "won",
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
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
          }
        ]
      }
    },
    {
      "name": "poolShare",
      "docs": [
        "The Pool's share of every realised Yield Fee, changeable only from a Season announced ahead."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "bps",
            "type": "u16"
          },
          {
            "name": "nextFrom",
            "docs": [
              "First Season the pending change applies to; 0 = none pending."
            ],
            "type": "u32"
          },
          {
            "name": "nextBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "railcarConfig",
      "docs": [
        "Railcar's settings and its one boarding line. The upgrade authority names the operator and",
        "the number of Tables (fixed once the first car opened, since a car's Table is",
        "`car_no % tables`)."
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
            "name": "tables",
            "type": "u16"
          },
          {
            "name": "nextCar",
            "docs": [
              "The number the next car gets."
            ],
            "type": "u64"
          },
          {
            "name": "boardingMatch",
            "docs": [
              "The core Match of the car boarding now (default before the first car)."
            ],
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "revealedBrake",
      "docs": [
        "One Player's Brake, made public with the ride's end."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "seat",
            "docs": [
              "The core seat index."
            ],
            "type": "u8"
          },
          {
            "name": "ms",
            "docs": [
              "Ride ms of the press."
            ],
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "revealedSeat",
      "docs": [
        "One seated Player of a finished ride."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "seat",
            "docs": [
              "The core seat index."
            ],
            "type": "u8"
          },
          {
            "name": "order",
            "docs": [
              "0 aboard at Impact, else the place in the Jump order (1 = first off)."
            ],
            "type": "u8"
          },
          {
            "name": "jumpMs",
            "docs": [
              "Ride ms of the Jump (0 aboard)."
            ],
            "type": "u32"
          },
          {
            "name": "refund",
            "docs": [
              "Gemas of the entry the result refunds."
            ],
            "type": "u64"
          },
          {
            "name": "player",
            "docs": [
              "The Player's core Account."
            ],
            "type": "pubkey"
          },
          {
            "name": "backer",
            "docs": [
              "The Backer who funded a backed seat's entry; none when the Player funded it."
            ],
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "shareBps",
            "docs": [
              "A backed seat's Player share of the winnings (the Offer's), in bps."
            ],
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "rideOver",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "carNo",
            "type": "u64"
          },
          {
            "name": "outcome",
            "type": "u8"
          },
          {
            "name": "reason",
            "type": "u8"
          },
          {
            "name": "overMs",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "rideRevealed",
      "docs": [
        "`reveal_ride` published a finished ride for the round history (event-CPI): everything the",
        "ride revealed (the draw and every Brake) and every seat, so anyone can name each Player and",
        "replay the ride. Keyed like core's Match records (`opener`, `n`)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "opener",
            "type": "pubkey"
          },
          {
            "name": "n",
            "type": "u64"
          },
          {
            "name": "carNo",
            "type": "u64"
          },
          {
            "name": "tesoroMatch",
            "type": "pubkey"
          },
          {
            "name": "outcome",
            "type": "u8"
          },
          {
            "name": "reason",
            "type": "u8"
          },
          {
            "name": "draw",
            "docs": [
              "The draw; zero when it never came."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "brakes",
            "type": {
              "vec": {
                "defined": {
                  "name": "revealedBrake"
                }
              }
            }
          },
          {
            "name": "seats",
            "type": {
              "vec": {
                "defined": {
                  "name": "revealedSeat"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "rideRunning",
      "docs": [
        "The draw is in and the ride clock runs from `ride_slot`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "carNo",
            "type": "u64"
          },
          {
            "name": "rideSlot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "rideSeat",
      "docs": [
        "One seat of a ride, public. Byte arrays only (alignment 1)."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "seat",
            "docs": [
              "The seat's index in the core many-seat Match."
            ],
            "type": "u8"
          },
          {
            "name": "order",
            "docs": [
              "0 while aboard, else the Player's place in the Jump order (1 = first off)."
            ],
            "type": "u8"
          },
          {
            "name": "flags",
            "type": "u8"
          },
          {
            "name": "reserved0",
            "type": "u8"
          },
          {
            "name": "jumpMs",
            "docs": [
              "Ride time of the Jump, real ms since the ride clock started."
            ],
            "type": {
              "array": [
                "u8",
                4
              ]
            }
          },
          {
            "name": "refund",
            "docs": [
              "Gemas of the entry the result refunds (written when the ride ends)."
            ],
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "account",
            "docs": [
              "The Player's core Account."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "signer",
            "docs": [
              "The seat key core recorded for this seat at join (`Seat::signer`, seat-keys decision D4),",
              "copied by `start_ride`. The Player's wallet acts for the seat too (`acts_for`)."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "brakeAt",
            "docs": [
              "After the ride: the Player's Brake, ride ms + 1 (0: no Brake). Zero during the ride."
            ],
            "type": {
              "array": [
                "u8",
                4
              ]
            }
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                4
              ]
            }
          }
        ]
      }
    },
    {
      "name": "rideStarted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "carNo",
            "type": "u64"
          },
          {
            "name": "table",
            "type": "u16"
          },
          {
            "name": "seated",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "seatRun",
      "docs": [
        "The frozen plan of a many-seat run and its cursor, read in place inside `ManySeatRecord`."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "kind",
            "type": "u8"
          },
          {
            "name": "phase",
            "type": "u8"
          },
          {
            "name": "nPlaces",
            "type": "u8"
          },
          {
            "name": "placeI",
            "type": "u8"
          },
          {
            "name": "seatI",
            "type": "u8"
          },
          {
            "name": "inSeat",
            "docs": [
              "1 once the cursor entered `seat_i` (its `seat_left` is loaded)."
            ],
            "type": "u8"
          },
          {
            "name": "visited",
            "docs": [
              "Seated seats the home phase has passed."
            ],
            "type": "u8"
          },
          {
            "name": "feesCapped",
            "type": "u8"
          },
          {
            "name": "lineI",
            "docs": [
              "Home phase: the next line to look at; forfeits phase: one past it (walked backward)."
            ],
            "type": {
              "array": [
                "u8",
                4
              ]
            }
          },
          {
            "name": "seatLeft",
            "docs": [
              "Gemas the current seat still moves in this phase."
            ],
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "wonLeft",
            "docs": [
              "Gemas the current place still gets, and of them the Backed Player's share still owed."
            ],
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "playerLeft",
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "fees",
            "type": {
              "array": [
                {
                  "array": [
                    "u8",
                    8
                  ]
                },
                3
              ]
            }
          },
          {
            "name": "cutLeft",
            "type": {
              "array": [
                {
                  "array": [
                    "u8",
                    8
                  ]
                },
                3
              ]
            }
          },
          {
            "name": "chunks",
            "type": {
              "array": [
                "u8",
                4
              ]
            }
          },
          {
            "name": "steps",
            "type": {
              "array": [
                "u8",
                4
              ]
            }
          },
          {
            "name": "places",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "placeSlot"
                  }
                },
                10
              ]
            }
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
      "name": "table",
      "docs": [
        "A Table: one ride at a time, delegated to the TEE validator and kept for months. Public: who",
        "boarded and who is aboard, the Jump order, the Tells shown, the ride start, the entry (the",
        "Gemas at stake are `entry * seated`) and the outcome. Read in place (no Borsh): a signal comes",
        "several times a second and touches a few bytes. Byte arrays only (alignment 1, no padding)."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "index",
            "type": {
              "array": [
                "u8",
                2
              ]
            }
          },
          {
            "name": "phase",
            "type": "u8"
          },
          {
            "name": "outcome",
            "type": "u8"
          },
          {
            "name": "reason",
            "type": "u8"
          },
          {
            "name": "tell",
            "docs": [
              "The later Tells shown so far (`TELL_BOLT`, `TELL_SPARKS`). A ride may show either, both",
              "or neither, and nothing here says one will not come."
            ],
            "type": "u8"
          },
          {
            "name": "screws",
            "docs": [
              "Screws heard so far: the false ones and the real ones in one count, so nothing public",
              "says which screw was real."
            ],
            "type": "u8"
          },
          {
            "name": "seated",
            "type": "u8"
          },
          {
            "name": "aboard",
            "type": "u8"
          },
          {
            "name": "jumps",
            "type": "u8"
          },
          {
            "name": "places",
            "docs": [
              "Table seats of the places, last Player off first (`NO_SEAT` when unused)."
            ],
            "type": {
              "array": [
                "u8",
                3
              ]
            }
          },
          {
            "name": "vaultReady",
            "docs": [
              "The Vault exists (`init_vault`)."
            ],
            "type": "u8"
          },
          {
            "name": "dirty",
            "docs": [
              "A result waits for its first commit."
            ],
            "type": "u8"
          },
          {
            "name": "reqPending",
            "type": "u8"
          },
          {
            "name": "reqCount",
            "type": "u8"
          },
          {
            "name": "commitTries",
            "type": "u8"
          },
          {
            "name": "reserved0",
            "type": {
              "array": [
                "u8",
                4
              ]
            }
          },
          {
            "name": "carNo",
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "nextCar",
            "docs": [
              "The car this Table takes next (`car_no % tables == index`, strictly in order)."
            ],
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "car",
            "docs": [
              "The Railcar `Car` account and its core Match."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "tesoroMatch",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "entry",
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "vrfNonce",
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "reqNonce",
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "reqSlot",
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "startedSlot",
            "docs": [
              "Slot of `start_ride` (the draw window runs from here)."
            ],
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "rideSlot",
            "docs": [
              "The ride clock: slot and time of the draw's arrival."
            ],
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "rideTs",
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "overMs",
            "docs": [
              "Ride ms and unix time at the end."
            ],
            "type": {
              "array": [
                "u8",
                4
              ]
            }
          },
          {
            "name": "overAt",
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "commitAt",
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "revealDraw",
            "docs": [
              "After the ride: the draw (with the seats' `brake_ms`, enough for the engine to recompute",
              "the ride), and `revealed` = 1. Zero during the ride."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "revealed",
            "type": "u8"
          },
          {
            "name": "brakesBound",
            "docs": [
              "Seats whose Brake seat is bound to this ride; no Brake counts until all are."
            ],
            "type": "u8"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                78
              ]
            }
          },
          {
            "name": "paceSlot",
            "docs": [
              "The pace mark: slot and time of the last moment the ride was on pace (outage rule)."
            ],
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "paceTs",
            "type": {
              "array": [
                "u8",
                8
              ]
            }
          },
          {
            "name": "seats",
            "type": {
              "array": [
                {
                  "defined": {
                    "name": "rideSeat"
                  }
                },
                100
              ]
            }
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
        "The private half of a ride: the VRF output, what it decides and the Brakes pressed. A",
        "rollup-only account behind a private permission with no member, created once per Table;",
        "nobody reads it during a ride."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "version",
            "type": "u8"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "table",
            "type": "pubkey"
          },
          {
            "name": "carNo",
            "docs": [
              "The car the draw below belongs to."
            ],
            "type": "u64"
          },
          {
            "name": "ready",
            "type": "bool"
          },
          {
            "name": "draw",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "crashMs",
            "type": "u32"
          },
          {
            "name": "screwAtMs",
            "type": "u32"
          },
          {
            "name": "boltAtMs",
            "docs": [
              "`engine::NEVER_MS` when the ride does not show the Tell: `ride::advance` then compares",
              "as for any other position and never passes it, so its work says nothing."
            ],
            "type": "u32"
          },
          {
            "name": "sparkAtMs",
            "type": "u32"
          },
          {
            "name": "falseScrews",
            "type": {
              "array": [
                "u32",
                4
              ]
            }
          },
          {
            "name": "falseLen",
            "type": "u8"
          },
          {
            "name": "slowEndMs",
            "docs": [
              "The Brake schedule: every press adds one 5 s slow piece after the earlier ones, so its end",
              "(`slow_end_ms`) and the slow time in all (`slow_total_ms`) give the track position at any",
              "moment from the last press on (`ride::half_position`)."
            ],
            "type": "u32"
          },
          {
            "name": "slowTotalMs",
            "type": "u32"
          },
          {
            "name": "pressCount",
            "docs": [
              "Presses in the order they landed (ride ms, ascending) and their Table seats, for the",
              "refunds and the reveal at the end."
            ],
            "type": "u8"
          },
          {
            "name": "presses",
            "type": {
              "array": [
                "u32",
                101
              ]
            }
          },
          {
            "name": "pressSeat",
            "type": {
              "array": [
                "u8",
                101
              ]
            }
          },
          {
            "name": "reserved",
            "docs": [
              "Room for the outage rule (ticket 08) and later."
            ],
            "type": {
              "array": [
                "u8",
                128
              ]
            }
          }
        ]
      }
    }
  ]
};
