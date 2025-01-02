export class Folder {
  constructor(
    public readonly id: number,
    public readonly name: string,
    public readonly user_id: number,
    public readonly created_at: Date,
    public readonly updated_at: Date,
  ) {}
}
