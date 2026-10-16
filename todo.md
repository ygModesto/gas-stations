# TODO

## Pestañas abiertas durante días y despliegues nuevos

**Problema.** Si la web se queda abierta en el móvil y entretanto se despliega código o datos nuevos:

- **El `index.html` no se actualiza solo.** Si el navegador conserva la pestaña, sigue ejecutando el código viejo hasta que se recargue. Si la descarta, al volver recarga, pero durante unos 10 minutos tras desplegar GitHub Pages puede servir aún la versión cacheada.
- **El `.fgb` se pide siempre a la misma URL sin versión** (`../public/gasolineras.fgb`), así que el código viejo lee datos nuevos. Riesgos:
  - **Mezcla en la caché HTTP:** en esa ventana de caché, el navegador podría combinar trozos (rangos) cacheados del fichero viejo con trozos del nuevo y fallar al leerlo. Es posible, pero no está comprobado.
  - **Cambio de formato:** si un despliegue cambia el esquema (columnas), el código viejo lo interpretaría mal.
- **Precios en memoria (`fgbCache`):** no se vuelven a pedir hasta salir de la zona ya cargada, así que se ven precios viejos.
- **`meta.json`:** solo se lee al cargar, y la fecha "Actualizado" queda desfasada.

**Posibles soluciones:**

- [ ] **Versionar el `.fgb`** con la fecha de `meta.json` (`gasolineras.fgb?v=<fecha>`). Cada versión tiene su URL, así que no se mezclan rangos en la caché y se sabe cuándo hay datos nuevos.
- [ ] **Comprobar al volver a la pestaña** (`visibilitychange`): pedir de nuevo `meta.json`, más una versión del código. Si ha cambiado, vaciar `fgbCache` y recargar los datos, o avisar con "hay una versión nueva, recargar".
