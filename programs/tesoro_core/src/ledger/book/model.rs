//! The independent reference model: the same rule in exact rational numbers.
//!
//! No index, no epochs, no fixed point, no pools: every holder of a class has an exact unpaid
//! amount, landing coverage pays classes in order and shares a class's coverage in proportion to
//! those amounts, and a move takes `k * ready / amount` of ready with the Gemas. The real ledger
//! must never show more ready than this model, and may show less only by the documented bound.

use num_bigint::{BigInt, Sign};
use num_integer::Integer;
use num_traits::{One, Signed, Zero};
use std::cmp::Ordering;
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rat {
    n: BigInt,
    d: BigInt, // always > 0
}

impl Rat {
    pub fn new(n: BigInt, d: BigInt) -> Rat {
        assert!(!d.is_zero());
        let (mut n, mut d) = if d.is_negative() { (-n, -d) } else { (n, d) };
        let g = n.gcd(&d);
        if !g.is_one() && !g.is_zero() {
            n /= &g;
            d /= &g;
        }
        Rat { n, d }
    }
    pub fn int(v: i128) -> Rat {
        Rat {
            n: BigInt::from(v),
            d: BigInt::one(),
        }
    }
    /// `v / 2^64`, i.e. a fixed-point value as Gemas.
    pub fn from_fp(v: u128) -> Rat {
        Rat::new(BigInt::from(v), BigInt::one() << 64usize)
    }
    /// `floor(self)`.
    pub fn floor_int(&self) -> BigInt {
        self.n.div_floor(&self.d)
    }
    pub fn to_f64(&self) -> f64 {
        use num_traits::ToPrimitive;
        let (n, d) = (
            self.n.to_f64().unwrap_or(f64::NAN),
            self.d.to_f64().unwrap_or(f64::NAN),
        );
        n / d
    }
    pub fn from_u128_pub(v: u128) -> Rat {
        Rat::new(BigInt::from(v), BigInt::one())
    }
    pub fn zero() -> Rat {
        Rat::int(0)
    }
    pub fn is_zero(&self) -> bool {
        self.n.is_zero()
    }
    pub fn add(&self, o: &Rat) -> Rat {
        Rat::new(&self.n * &o.d + &o.n * &self.d, &self.d * &o.d)
    }
    pub fn sub(&self, o: &Rat) -> Rat {
        Rat::new(&self.n * &o.d - &o.n * &self.d, &self.d * &o.d)
    }
    pub fn mul(&self, o: &Rat) -> Rat {
        Rat::new(&self.n * &o.n, &self.d * &o.d)
    }
    pub fn div(&self, o: &Rat) -> Rat {
        Rat::new(&self.n * &o.d, &self.d * &o.n)
    }
    pub fn lesser(&self, o: &Rat) -> Rat {
        if self <= o {
            self.clone()
        } else {
            o.clone()
        }
    }
    /// `floor(self * 2^64)` as the fixed-point value; the number must be non-negative.
    pub fn floor_fp(&self) -> BigInt {
        assert!(self.n.sign() != Sign::Minus);
        (&self.n << 64usize).div_floor(&self.d)
    }
}

impl PartialOrd for Rat {
    fn partial_cmp(&self, o: &Rat) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Rat {
    fn cmp(&self, o: &Rat) -> Ordering {
        (&self.n * &o.d).cmp(&(&o.n * &self.d))
    }
}

#[derive(Clone, Debug)]
pub struct MLine {
    pub amount: u64,
    pub unpaid: Rat,
    /// Staking-token shares the line owns, in units of 2^-32 share (like the ledger's).
    pub shares: Rat,
}

impl MLine {
    pub fn ready(&self) -> Rat {
        Rat::int(self.amount as i128).sub(&self.unpaid)
    }
}

/// Holder id and class: one line each.
pub type LineId = (u8, u8);

#[derive(Clone, Debug, Default)]
pub struct Model {
    pub lines: BTreeMap<LineId, MLine>,
    /// Classes in use (the three fee classes, General and the started Extensions).
    pub classes: usize,
    /// Ready returned to the owner by `return_own` (exact).
    pub returned: Rat,
    /// Coverage nobody was owed, handed to the owner (exact).
    pub excess: Rat,
}

impl Default for Rat {
    fn default() -> Rat {
        Rat::zero()
    }
}

impl Model {
    pub fn new() -> Model {
        Model {
            classes: 4,
            ..Model::default()
        }
    }

    pub fn start_extension(&mut self) {
        self.classes += 1;
    }

    fn line_mut(&mut self, id: LineId) -> &mut MLine {
        self.lines.entry(id).or_insert_with(|| MLine {
            amount: 0,
            unpaid: Rat::zero(),
            shares: Rat::zero(),
        })
    }

    pub fn unpaid_of_class(&self, class: u8) -> Rat {
        self.lines
            .iter()
            .filter(|((_, c), _)| *c == class)
            .fold(Rat::zero(), |acc, (_, l)| acc.add(&l.unpaid))
    }

    pub fn unpaid_total(&self) -> Rat {
        (0..self.classes as u8).fold(Rat::zero(), |acc, c| acc.add(&self.unpaid_of_class(c)))
    }

    pub fn issue(&mut self, id: LineId, k: u64) {
        let l = self.line_mut(id);
        l.amount += k;
        l.unpaid = l.unpaid.add(&Rat::int(k as i128));
    }

    /// Pay classes in order; what no class owes is returned. `q` shares (2^-32 units) are split by
    /// what each class takes, and each class hands its part to its lines by their unpaid share.
    pub fn land(&mut self, delta: &Rat, q: &Rat) -> Rat {
        let mut rest = delta.clone();
        for class in 0..self.classes as u8 {
            if rest.is_zero() {
                break;
            }
            let total = self.unpaid_of_class(class);
            if total.is_zero() {
                continue;
            }
            let pay = rest.lesser(&total);
            let keep = total.sub(&pay).div(&total); // fraction of each line still unpaid
            let q_class = q.mul(&pay).div(delta);
            for ((_, c), l) in self.lines.iter_mut() {
                if *c == class {
                    let gain = q_class.mul(&l.unpaid).div(&total);
                    l.shares = l.shares.add(&gain);
                    l.unpaid = l.unpaid.mul(&keep);
                }
            }
            rest = rest.sub(&pay);
        }
        self.excess = self.excess.add(&rest);
        rest
    }

    /// Move `k` Gemas of `src` to `dst` with their proportional ready. `dst` may be of another class
    /// (a fee cut); the Gemas' unpaid part simply changes class.
    pub fn transfer(&mut self, src: LineId, dst: LineId, k: u64) {
        let (a, unpaid) = {
            let l = self.line_mut(src);
            (l.amount, l.unpaid.clone())
        };
        let moved = unpaid.mul(&Rat::int(k as i128)).div(&Rat::int(a as i128));
        let moved_shares = self
            .line_mut(src)
            .shares
            .mul(&Rat::int(k as i128))
            .div(&Rat::int(a as i128));
        {
            let l = self.line_mut(src);
            l.amount -= k;
            l.unpaid = l.unpaid.sub(&moved);
            l.shares = l.shares.sub(&moved_shares);
        }
        let l = self.line_mut(dst);
        l.amount += k;
        l.unpaid = l.unpaid.add(&moved);
        l.shares = l.shares.add(&moved_shares);
    }

    /// Redeem `k`. The real ledger may let a holder redeem a Gema when the exact ready is a few
    /// units of 2^-64 short of it; the model then forgives that much unpaid and returns it.
    pub fn redeem(&mut self, id: LineId, k: u64, paid_q32: u128, flush: bool) -> Rat {
        let l = self.line_mut(id);
        l.amount -= k;
        l.shares = l.shares.sub(&Rat::from_u128_pub(paid_q32));
        if flush && l.amount == 0 {
            l.shares = Rat::zero();
        }
        let cap = Rat::int(l.amount as i128);
        if l.unpaid > cap {
            let forgiven = l.unpaid.sub(&cap);
            l.unpaid = cap;
            return forgiven;
        }
        Rat::zero()
    }

    /// `return_own`: the proportional ready goes to the owner, the rest is cancelled.
    pub fn return_own(&mut self, id: LineId, k: u64) {
        let (a, unpaid) = {
            let l = self.line_mut(id);
            (l.amount, l.unpaid.clone())
        };
        let cancelled = unpaid.mul(&Rat::int(k as i128)).div(&Rat::int(a as i128));
        let ready = Rat::int(k as i128).sub(&cancelled);
        self.returned = self.returned.add(&ready);
        let l = self.line_mut(id);
        let moved_shares = l.shares.mul(&Rat::int(k as i128)).div(&Rat::int(a as i128));
        l.amount -= k;
        l.unpaid = l.unpaid.sub(&cancelled);
        l.shares = l.shares.sub(&moved_shares);
    }
}
