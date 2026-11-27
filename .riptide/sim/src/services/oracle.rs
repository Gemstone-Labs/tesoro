#![allow(dead_code)]

use riptide_sim::{Service, World};

#[derive(Debug, Default)]
pub struct OracleService;

impl Service for OracleService {
    fn tick(&mut self, _world: &mut World) {}
}
