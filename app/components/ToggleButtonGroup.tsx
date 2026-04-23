"use client";

import type { CSSProperties } from "react";

interface ToggleButtonGroupProps<T extends string> {
  items: readonly T[];
  value: T;
  onChange: (value: T) => void;
  wrap?: boolean;
  marginTop?: number;
  gap?: number;
}

export default function ToggleButtonGroup<T extends string>({
  items,
  value,
  onChange,
  wrap = false,
  marginTop = 0,
  gap = 8,
}: ToggleButtonGroupProps<T>) {
  const container: CSSProperties = {
    display: "flex",
    gap,
    marginTop,
    ...(wrap ? { flexWrap: "wrap" } : {}),
  };
  return (
    <div style={container}>
      {items.map((item) => (
        <button
          key={item}
          type="button"
          onClick={() => onChange(item)}
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            fontSize: 12,
            color: item === value ? "var(--text-primary)" : "var(--text-muted)",
            padding: "2px 0",
          }}
        >
          {item}
        </button>
      ))}
    </div>
  );
}
