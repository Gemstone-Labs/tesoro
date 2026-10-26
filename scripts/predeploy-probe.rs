// Host-only account layout probe. These types and constants are the ones the program build compiles.
use anchor_lang::prelude::*;
use std::cell::RefCell;

type Decoder = fn(&[u8]) -> bool;

thread_local! {
    static DECODERS: RefCell<Vec<(String, Decoder)>> = const { RefCell::new(Vec::new()) };
}

pub fn fixed<T: Discriminator + AccountDeserialize>(name: &str, size: usize) {
    println!("TESORO_LAYOUT {{\"type\":\"{}\",\"discriminator\":{:?},\"base\":{},\"stride\":0,\"maxExtra\":0}}", name, T::DISCRIMINATOR, size);
    DECODERS.with(|d| {
        d.borrow_mut().push((name.to_string(), |data| {
            T::try_deserialize(&mut &data[..]).is_ok()
        }))
    });
}

/// Exact lengths of historical records that only the admin retire instructions touch.
pub fn retired(name: &str, sizes: &[usize]) {
    let sizes = sizes.iter().map(|s| s.to_string()).collect::<Vec<_>>().join(",");
    println!("TESORO_RETIRED {{\"type\":\"{}\",\"sizes\":[{}]}}", name, sizes);
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2)
        .map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).expect("hex"))
        .collect()
}

/// With TESORO_DECODE_INPUT=<file of `type<TAB>address<TAB>hex` lines>, runs the program's own
/// deserializer on each record and prints one TESORO_DECODE line per record.
pub fn decode_report() {
    let Ok(path) = std::env::var("TESORO_DECODE_INPUT") else {
        return;
    };
    let text = std::fs::read_to_string(path).expect("decode input");
    for line in text.lines().filter(|l| !l.is_empty()) {
        let mut parts = line.split('\t');
        let (name, address, hex) = (
            parts.next().expect("type"),
            parts.next().expect("address"),
            parts.next().expect("hex"),
        );
        let data = unhex(hex);
        let ok = DECODERS.with(|d| {
            d.borrow()
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, f)| f(&data))
                .unwrap_or(false)
        });
        println!("TESORO_DECODE {{\"address\":\"{}\",\"ok\":{}}}", address, ok);
    }
}
