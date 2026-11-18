/** Lo que el resto de la aplicación necesita saber de los usuarios. */
export interface UserDirectory {
  exists(userId: number): Promise<boolean>;
}
