import type { MapWorld } from "../../../shared/map";
import type { MapPlayer } from "../../../shared/map-players";

export function worldForPlayer(player: MapPlayer, worlds: MapWorld[]) {
  if (!player.position) return;
  if (player.position.world) return worlds.find(world => world.id === player.position!.world);
  const matches = worlds.filter(world => world.dimension === player.position!.dimension);
  return matches.length === 1 ? matches[0] : undefined;
}

export function playerMarkers(players: MapPlayer[], worlds: MapWorld[], selected: string,
  project: (position: { x: number; y: number; z: number }) => { x: number; y: number } | undefined) {
  return players.flatMap(player => {
    if (!player.position || worldForPlayer(player, worlds)?.id !== selected) return [];
    const position = { ...player.position, y: player.position.y + 1.9 };
    const point = project(position);
    if (!point) return [];
    const yaw = player.position.yaw;
    const facing = yaw === undefined ? undefined : project({ ...position,
      x: position.x - Math.sin(yaw * Math.PI / 180) * 4, z: position.z + Math.cos(yaw * Math.PI / 180) * 4 });
    const angle = facing && Math.hypot(facing.x - point.x, facing.y - point.y) > 0.1
      ? Math.atan2(facing.y - point.y, facing.x - point.x) * 180 / Math.PI + 90 : undefined;
    return [{ name: player.name, ...point, angle }];
  });
}
