"use client";
import { useEffect, useState } from "react";
import { api } from "../../lib/api/endpoints";
import { patientName } from "../../lib/format";

const cache = new Map<string, Promise<string | null>>();
const lookup = (id: string) => {
  let p = cache.get(id);
  if (!p) {
    p = api.patients.get(id).then(
      (r) => patientName(r),
      () => {
        cache.delete(id);
        return null;
      },
    );
    cache.set(id, p);
  }
  return p;
};

/** Resolves patient ids (as listed on outbox rows, which carry ids only) to display names. */
export function usePatientNames(ids: (string | null | undefined)[]) {
  const [names, setNames] = useState<Record<string, string>>({});
  const key = [...new Set(ids.filter((i): i is string => Boolean(i)))].sort().join(",");
  useEffect(() => {
    let live = true;
    for (const id of key ? key.split(",") : []) {
      lookup(id).then((n) => {
        if (live && n) setNames((cur) => (cur[id] === n ? cur : { ...cur, [id]: n }));
      });
    }
    return () => {
      live = false;
    };
  }, [key]);
  return names;
}
