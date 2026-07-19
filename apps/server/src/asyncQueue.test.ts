import { describe, expect, it } from "vitest";
import { AsyncQueue } from "./asyncQueue.js";

async function drain<T>(queue: AsyncQueue<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of queue) items.push(item);
  return items;
}

describe("AsyncQueue", () => {
  it("yields items pushed before consumption starts, in order", async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.close();

    expect(await drain(queue)).toEqual([1, 2]);
  });

  it("yields items pushed after consumption has already started waiting", async () => {
    const queue = new AsyncQueue<number>();
    const resultPromise = drain(queue);

    queue.push(1);
    queue.push(2);
    queue.close();

    expect(await resultPromise).toEqual([1, 2]);
  });

  it("ends iteration once closed with no further items", async () => {
    const queue = new AsyncQueue<number>();
    queue.close();

    expect(await drain(queue)).toEqual([]);
  });

  it("lets an already-waiting consumer resolve done once closed with no more pushes", async () => {
    const queue = new AsyncQueue<number>();
    const resultPromise = drain(queue);

    queue.close();

    expect(await resultPromise).toEqual([]);
  });

  it("interleaves waiting consumption with later pushes in push order", async () => {
    const queue = new AsyncQueue<string>();
    const items: string[] = [];

    const consumer = (async () => {
      for await (const item of queue) items.push(item);
    })();

    queue.push("a");
    await Promise.resolve();
    queue.push("b");
    queue.close();
    await consumer;

    expect(items).toEqual(["a", "b"]);
  });
});
