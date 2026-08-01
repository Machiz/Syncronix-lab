# Contribuir a WireWatch MCU

Gracias por colaborar con el proyecto.

## Preparación del entorno

```bash
python -m venv .venv
```

Windows:

```powershell
.venv\Scripts\activate
pip install -r requirements-dev.txt
```

Linux/macOS:

```bash
source .venv/bin/activate
pip install -r requirements-dev.txt
```

## Ejecutar pruebas

```bash
python -m pytest
```

## Reglas para nuevas fichas de sensores

- Use como fuente principal la hoja de datos del fabricante.
- Indique el intervalo de voltaje del componente y del módulo por separado
  cuando sean diferentes.
- No copie páginas completas ni material protegido.
- Añada alias, interfaces, direcciones y nombres de señales.
- Marque claramente cualquier dato no verificado.

## Pull requests

1. Cree una rama para el cambio.
2. Mantenga los cambios pequeños y explicables.
3. Añada pruebas cuando modifique el analizador o el diagnóstico.
4. Compruebe que `python -m pytest` finalice correctamente.
