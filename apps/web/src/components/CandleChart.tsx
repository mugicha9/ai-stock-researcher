"use client";

import { useMemo, useState } from "react";
import type { EventRecord, PricePoint } from "../lib/api";
import { formatDate, formatNumber } from "../lib/format";

type Interval = "1d" | "1w" | "1m";

function aggregate(points: PricePoint[], interval: Interval): PricePoint[] {
  const size = interval === "1d" ? 1 : interval === "1w" ? 5 : 20;
  const result: PricePoint[] = [];
  for (let index = 0; index < points.length; index += size) {
    const chunk = points.slice(index, index + size);
    if (!chunk.length) continue;
    result.push({
      date: chunk[chunk.length - 1].date,
      open: chunk[0].open,
      high: Math.max(...chunk.map((item) => item.high)),
      low: Math.min(...chunk.map((item) => item.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((sum, item) => sum + item.volume, 0),
      adjusted_close: chunk[chunk.length - 1].adjusted_close
    });
  }
  return result;
}

function movingAverage(points: PricePoint[], index: number, window: number): number | null {
  if (index + 1 < window) return null;
  const slice = points.slice(index - window + 1, index + 1);
  return slice.reduce((sum, item) => sum + item.close, 0) / window;
}

export function CandleChart({ prices, events }: { prices: PricePoint[]; events: EventRecord[] }) {
  const [interval, setInterval] = useState<Interval>("1d");
  const [selectedEvent, setSelectedEvent] = useState<EventRecord | null>(null);
  const data = useMemo(() => aggregate(prices, interval).slice(-60), [prices, interval]);

  const width = 900;
  const height = 360;
  const priceHeight = 245;
  const volumeTop = 282;
  const padX = 38;
  const candleWidth = Math.max(5, Math.min(13, (width - padX * 2) / Math.max(data.length, 1) - 4));

  if (!data.length) {
    return (
      <div className="chart-shell">
        <div className="chart-toolbar">
          <div className="segmented" aria-label="chart interval">
            {[
              ["1d", "日足"],
              ["1w", "週足"],
              ["1m", "月足"]
            ].map(([value, label]) => (
              <button
                className={interval === value ? "active" : ""}
                key={value}
                type="button"
                onClick={() => setInterval(value as Interval)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="empty-chart">株価データがありません</div>
      </div>
    );
  }

  const minLow = Math.min(...data.map((item) => item.low));
  const maxHigh = Math.max(...data.map((item) => item.high));
  const maxVolume = Math.max(...data.map((item) => item.volume));
  const priceRange = Math.max(1, maxHigh - minLow);

  const xFor = (index: number) => padX + (index + 0.5) * ((width - padX * 2) / Math.max(data.length, 1));
  const yFor = (price: number) => 20 + ((maxHigh - price) / priceRange) * priceHeight;
  const volumeY = (volume: number) => volumeTop + (1 - volume / Math.max(maxVolume, 1)) * 55;
  const dateIndex = new Map(data.map((item, index) => [item.date, index]));

  const markerEvents = events
    .map((event) => {
      const date = String(event.published_at ?? "").slice(0, 10);
      const index = dateIndex.get(date);
      return index === undefined ? null : { event, index };
    })
    .filter(Boolean) as { event: EventRecord; index: number }[];

  return (
    <div className="chart-shell">
      <div className="chart-toolbar">
        <div className="segmented" aria-label="chart interval">
          {[
            ["1d", "日足"],
            ["1w", "週足"],
            ["1m", "月足"]
          ].map(([value, label]) => (
            <button
              className={interval === value ? "active" : ""}
              key={value}
              type="button"
              onClick={() => setInterval(value as Interval)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="chart-last">
          終値 <strong>{formatNumber(data.at(-1)?.close, 0)}</strong>
        </div>
      </div>
      <svg className="candle-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="candlestick chart">
        <rect x="0" y="0" width={width} height={height} rx="8" className="chart-bg" />
        {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
          const y = 20 + tick * priceHeight;
          const value = maxHigh - tick * priceRange;
          return (
            <g key={tick}>
              <line x1={padX} x2={width - padX} y1={y} y2={y} className="grid-line" />
              <text x={width - padX + 8} y={y + 4} className="axis-label">
                {formatNumber(value, 0)}
              </text>
            </g>
          );
        })}
        {data.map((item, index) => {
          const x = xFor(index);
          const openY = yFor(item.open);
          const closeY = yFor(item.close);
          const highY = yFor(item.high);
          const lowY = yFor(item.low);
          const up = item.close >= item.open;
          const bodyY = Math.min(openY, closeY);
          const bodyHeight = Math.max(2, Math.abs(closeY - openY));
          return (
            <g key={`${item.date}-${index}`}>
              <line x1={x} x2={x} y1={highY} y2={lowY} className={up ? "wick up" : "wick down"} />
              <rect
                x={x - candleWidth / 2}
                y={bodyY}
                width={candleWidth}
                height={bodyHeight}
                rx="2"
                className={up ? "candle up" : "candle down"}
              />
              <rect
                x={x - candleWidth / 2}
                y={volumeY(item.volume)}
                width={candleWidth}
                height={Math.max(1, 337 - volumeY(item.volume))}
                rx="1"
                className="volume-bar"
              />
            </g>
          );
        })}
        {[5, 20].map((window) => {
          const points = data
            .map((item, index) => {
              const average = movingAverage(data, index, window);
              return average === null ? null : `${xFor(index)},${yFor(average)}`;
            })
            .filter(Boolean)
            .join(" ");
          return <polyline key={window} points={points} className={window === 5 ? "ma fast" : "ma slow"} />;
        })}
        {markerEvents.map(({ event, index }) => (
          <g
            className="event-marker-hit"
            key={event.id}
            role="button"
            tabIndex={0}
            onClick={() => setSelectedEvent(event)}
            onKeyDown={(keyboardEvent) => {
              if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") setSelectedEvent(event);
            }}
          >
            <circle cx={xFor(index)} cy={yFor(data[index].high) - 12} r="6" className="event-marker" />
            <title>{event.title}</title>
          </g>
        ))}
        {data.map((item, index) =>
          index % Math.max(1, Math.ceil(data.length / 6)) === 0 ? (
            <text key={item.date} x={xFor(index)} y={354} className="date-label" textAnchor="middle">
              {formatDate(item.date)}
            </text>
          ) : null
        )}
      </svg>
      {selectedEvent ? (
        <div className="chart-event">
          <strong>{selectedEvent.title}</strong>
          <span>{selectedEvent.summary}</span>
        </div>
      ) : null}
    </div>
  );
}
