interface TableEpoch {
  generation: number;
  index: number;
  epoch: number;
}

/** An idle table is assigned by its epoch; begin_match writes its Match key afterwards. */
export function atAssignedEpoch(assignment: TableEpoch, table: TableEpoch): boolean {
  return assignment.generation === table.generation && assignment.index === table.index && assignment.epoch === table.epoch;
}
