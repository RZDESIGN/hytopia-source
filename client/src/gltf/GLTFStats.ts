export default class GLTFStats {
  public static fileCount: number = 0;
  public static sourceMeshCount: number = 0;
  public static clonedMeshCount: number = 0;
  public static instancedMeshCount: number = 0;
  public static drawCallsSaved: number = 0;
  public static attributeElementsUpdated: number = 0;
  public static attributeUploadsSkipped: number = 0;

  public static reset(): void {
    GLTFStats.drawCallsSaved = 0;
    GLTFStats.attributeElementsUpdated = 0;
    GLTFStats.attributeUploadsSkipped = 0;
  }
}