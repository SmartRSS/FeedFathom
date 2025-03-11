export class Folder {
  constructor(
    public readonly id: number,
    public readonly name: string,
    // biome-ignore lint/style/useNamingConvention: <explanation>
    public readonly user_id: number,
    // biome-ignore lint/style/useNamingConvention: <explanation>
    public readonly created_at: Date,
    // biome-ignore lint/style/useNamingConvention: <explanation>
    public readonly updated_at: Date,
  ) {}
}
