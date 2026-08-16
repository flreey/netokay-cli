declare function validate(value: unknown): boolean;
declare namespace validate {
  let errors: readonly unknown[] | null | undefined;
}

export default validate;
export { validate };
