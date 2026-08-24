"use client";

import { Children, cloneElement, isValidElement, useMemo, useState, type ReactNode } from "react";

type SortState = { column: number; direction: "ascending" | "descending" } | null;

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join(" ");
  if (isValidElement<{ children?: ReactNode }>(node)) return textContent(node.props.children);
  return "";
}

function sortableValue(node: ReactNode) {
  const text = textContent(node).replace(/\s+/g, " ").trim();
  const numeric = Number(text.replace(/[$,%]/g, "").replace(/,/g, ""));
  return text !== "" && Number.isFinite(numeric) ? numeric : text;
}

export function SortableDataTable({ caption, headers, children }: {
  caption: string;
  headers: string[];
  children: ReactNode;
}) {
  const [sort, setSort] = useState<SortState>(null);
  const rows = useMemo(() => Children.toArray(children), [children]);
  const displayedRows = useMemo(() => {
    if (!sort) return rows;
    return rows.map((row, originalIndex) => ({ row, originalIndex })).toSorted((left, right) => {
      const leftCells = isValidElement<{ children?: ReactNode }>(left.row) ? Children.toArray(left.row.props.children) : [];
      const rightCells = isValidElement<{ children?: ReactNode }>(right.row) ? Children.toArray(right.row.props.children) : [];
      const a = sortableValue(leftCells[sort.column]);
      const b = sortableValue(rightCells[sort.column]);
      const comparison = typeof a === "number" && typeof b === "number"
        ? a - b
        : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
      return (sort.direction === "ascending" ? comparison : -comparison) || left.originalIndex - right.originalIndex;
    }).map((item) => item.row);
  }, [rows, sort]);

  const labelledRows = displayedRows.map((row) => {
    if (!isValidElement<{ children?: ReactNode }>(row)) return row;
    const labelledCells = Children.map(row.props.children, (cell, index) => {
      if (!isValidElement<{ children?: ReactNode; "data-label"?: string }>(cell)) return cell;
      return cloneElement(cell, { "data-label": headers[index] ?? "" });
    });
    return cloneElement(row, undefined, labelledCells);
  });

  function changeSort(column: number) {
    setSort((current) => current?.column === column
      ? { column, direction: current.direction === "ascending" ? "descending" : "ascending" }
      : { column, direction: "ascending" });
  }

  return <div className="responsive-table">
    <p className="table-scroll-hint">Select a column heading to sort. Swipe horizontally to see all columns.</p>
    <div className="table-scroll" tabIndex={0} role="region" aria-label={caption}>
      <table className="data-table">
        <caption className="sr-only">{caption}</caption>
        <thead><tr>{headers.map((header, index) => <th
          scope="col"
          key={`${header}:${index}`}
          aria-sort={sort?.column === index ? sort.direction : "none"}
        >
          <button className="table-sort-button" type="button" onClick={() => changeSort(index)}>
            {header}<span aria-hidden="true">{sort?.column === index ? sort.direction === "ascending" ? " ↑" : " ↓" : " ↕"}</span>
          </button>
        </th>)}</tr></thead>
        <tbody>{labelledRows}</tbody>
      </table>
    </div>
  </div>;
}
