// Host-only account layout probe. These types and constants are the ones the program build compiles.
use anchor_lang::prelude::*;

pub fn fixed<T: Discriminator>(name: &str, size: usize) {
    println!("TESORO_LAYOUT {{\"type\":\"{}\",\"discriminator\":{:?},\"base\":{},\"stride\":0,\"maxExtra\":0}}", name, T::DISCRIMINATOR, size);
}
