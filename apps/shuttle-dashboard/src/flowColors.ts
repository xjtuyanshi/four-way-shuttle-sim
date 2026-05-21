import type { LoadStateRecord, ShuttleSimState, TaskStateRecord, VehicleState } from '@four-way-shuttle/schemas';

export type LoadFlowRole = 'inbound' | 'outbound';

export const FLOW_VISUAL_COLORS: Record<LoadFlowRole, { hex: string; rgb: string; three: number }> = {
  inbound: {
    hex: '#4f8fcb',
    rgb: '79, 143, 203',
    three: 0x4f8fcb
  },
  outbound: {
    hex: '#e2b84b',
    rgb: '226, 184, 75',
    three: 0xe2b84b
  }
};

export function flowRgba(role: LoadFlowRole, opacity: number): string {
  return `rgba(${FLOW_VISUAL_COLORS[role].rgb}, ${opacity})`;
}

function activeTaskForLoad(state: ShuttleSimState, loadId: string): TaskStateRecord | null {
  return state.tasks.find((task) =>
    task.loadId === loadId &&
    task.state !== 'completed' &&
    task.state !== 'failed'
  ) ?? null;
}

function activeTaskForVehicle(state: ShuttleSimState, vehicle: VehicleState): TaskStateRecord | null {
  if (!vehicle.taskId) {
    return null;
  }

  return state.tasks.find((task) =>
    task.id === vehicle.taskId &&
    task.state !== 'completed' &&
    task.state !== 'failed'
  ) ?? null;
}

export function resolveLoadFlowRole(state: ShuttleSimState, load: LoadStateRecord): LoadFlowRole {
  return activeTaskForLoad(state, load.id)?.kind ?? 'inbound';
}

export function resolveVehicleTaskFlowRole(state: ShuttleSimState, vehicle: VehicleState): LoadFlowRole | null {
  return activeTaskForVehicle(state, vehicle)?.kind ?? null;
}

export function resolveVehicleLoadFlowRole(state: ShuttleSimState, vehicle: VehicleState): LoadFlowRole {
  const activeTask = activeTaskForVehicle(state, vehicle);
  if (activeTask) {
    return activeTask.kind;
  }

  const carriedLoad = state.loads.find((load) => load.vehicleId === vehicle.id && load.state === 'carried');
  return carriedLoad ? resolveLoadFlowRole(state, carriedLoad) : 'inbound';
}
