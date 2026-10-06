// Resolve an ability's referenced animation and effects (asset ids) from the library, loading
// them on demand, for previews and thumbnails.
import { useEffect, useMemo } from "react";
import { loadAsset, useStore } from "../store.ts";
import { abilityRefs, resolveAbility, type AbilitySpec, type ResolvedAbility } from "../../shared/ability.ts";

export function useResolvedAbility(spec: AbilitySpec | null | undefined): ResolvedAbility | null {
  const cache = useStore((s) => s.assetCache);
  const assets = useStore((s) => s.assets);
  const refs = useMemo(() => (spec ? abilityRefs(spec) : []), [spec]);
  useEffect(() => {
    for (const id of refs) if (!cache[id] && assets.some((a) => a.id === id)) void loadAsset(id);
  }, [refs, cache, assets]);
  const deps = refs.map((id) => cache[id]);
  return useMemo(
    () => (spec ? resolveAbility(spec, (id) => cache[id]) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spec, ...deps],
  );
}
