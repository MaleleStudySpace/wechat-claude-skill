/**
 * Message queue for WeChat → Claude injection.
 *
 * Thread-safe FIFO queue with deduplication by msgId.
 */

export interface QueueItem {
  msgId: string;
  from: string;
  text: string;
  timestamp: number;
  /** Whether this item has been shown in terminal as notification (while waiting for Claude to be idle) */
  notified?: boolean;
}

export class MessageQueue {
  private items: QueueItem[] = [];
  private seen = new Set<string>();

  enqueue(item: QueueItem): boolean {
    if (this.seen.has(item.msgId)) return false;
    this.seen.add(item.msgId);
    this.items.push(item);
    return true;
  }

  dequeue(): QueueItem | undefined {
    return this.items.shift();
  }

  peek(): QueueItem | undefined {
    return this.items[0];
  }

  /** Dequeue all items. Returns items in FIFO order. Does NOT clear seen set
   *  so that requeued items won't be re-enqueued by duplicate messages. */
  dequeueAll(): QueueItem[] {
    const items = this.items;
    this.items = [];
    return items;
  }

  /** Re-add items to the front of the queue (preserves FIFO order).
   *  Used when only the first item was consumed and the rest need to wait. */
  requeue(items: QueueItem[]): void {
    this.items = [...items, ...this.items];
  }

  get length(): number {
    return this.items.length;
  }

  get isEmpty(): boolean {
    return this.items.length === 0;
  }

  clear(): void {
    this.items = [];
    this.seen.clear();
  }
}
