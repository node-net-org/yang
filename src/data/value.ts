/**
 * Typed values of YANG leaves, leaf-list entries and annotations, and their
 * canonical forms (RFC 7950 §9).
 *
 * | Built-in type                      | JavaScript value          |
 * |------------------------------------|---------------------------|
 * | int8 … int32, uint8 … uint32       | `number`                  |
 * | int64, uint64                      | `bigint`                  |
 * | decimal64                          | {@link Decimal64}         |
 * | string, enumeration                | `string`                  |
 * | boolean                            | `boolean`                 |
 * | empty                              | `null`                    |
 * | binary                             | `Uint8Array`              |
 * | bits                               | `string[]`, in position order |
 * | identityref                        | {@link Identity}          |
 * | instance-identifier                | {@link InstanceIdentifier} |
 *
 * leafref and union are never the type of a value: a value always carries
 * the concrete type it was read as (the leafref's target type, or the union
 * member that matched), because that type decides its JSON encoding.
 */

import type { Identity, LeafListNode, LeafNode, SchemaNode, YangType } from '../schema/model.js';

export type YangValue = string | number | bigint | boolean | null | Decimal64 | Uint8Array | readonly string[] | Identity | InstanceIdentifier;

/** A value with the concrete type it was read as. */
export interface TypedValue {
  /** Never a leafref or union: the target or member type that applied. */
  readonly type: YangType;
  readonly value: YangValue;
}

/** A decimal64 value: an integer scaled by 10^fractionDigits. */
export class Decimal64 {
  /** The value times 10^fractionDigits. */
  readonly scaled: bigint;
  readonly fractionDigits: number;

  constructor(scaled: bigint, fractionDigits: number) {
    this.scaled = scaled;
    this.fractionDigits = fractionDigits;
  }

  /**
   * The canonical form (RFC 7950 §9.3.2): no plus sign, no leading or
   * trailing zeros, but at least one digit on each side of the point.
   */
  toString(): string {
    const neg = this.scaled < 0n;
    const digits = (neg ? -this.scaled : this.scaled).toString().padStart(this.fractionDigits + 1, '0');
    const whole = digits.slice(0, digits.length - this.fractionDigits);
    const fraction = digits.slice(digits.length - this.fractionDigits).replace(/0+$/, '');
    return `${neg ? '-' : ''}${whole}.${fraction === '' ? '0' : fraction}`;
  }

  /** The nearest JavaScript number. Precision may be lost. */
  toNumber(): number {
    return Number(this.toString());
  }

  equals(other: Decimal64): boolean {
    return this.scaled === other.scaled && this.fractionDigits === other.fractionDigits;
  }
}

/** A parsed instance-identifier value (RFC 7950 §9.13), resolved against the schema. */
export interface InstanceIdentifier {
  readonly steps: readonly InstanceIdentifierStep[];
}

export interface InstanceIdentifierStep {
  /** A container, list, leaf, leaf-list, anydata or anyxml node. */
  readonly node: SchemaNode;
  /** Key predicates of a list step, in the order written. */
  readonly keys?: readonly { readonly key: LeafNode; readonly value: TypedValue }[];
  /** The value predicate of a leaf-list step (`[.='value']`). */
  readonly value?: TypedValue;
  /** A positional predicate (`[2]`), 1-based. */
  readonly position?: number;
}

/** A leaf or leaf-list's schema node, for which values are read. */
export type ValueNode = LeafNode | LeafListNode;
