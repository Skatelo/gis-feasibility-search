# Verified NC county zoning MapServer endpoints

Only MapServer/ImageServer support the ArcGIS `export` op the overlay uses.
For the visual overlay, the MapServer root renders all its zoning sublayers.
`code`/`desc` fields are for the point zoning-code lookup (card value).

| County | MapServer URL | layer | code field | desc field | status |
|---|---|---|---|---|---|
| Mecklenburg | https://meckgis.mecklenburgcountync.gov/server/rest/services/CityofCharlotteZoning/MapServer | 0 | zoneclass | zonedes | ✓ city |
| Mecklenburg | https://meckgis.mecklenburgcountync.gov/server/rest/services/UnincorporatedCountyandTownsZoning/MapServer | 0 | ? | ? | ✓ county/towns |
| Wake | https://maps.wake.gov/arcgis/rest/services/Planning/Zoning/MapServer | 17 (County) | CLASS | - | ✓ all munis |
| Union | https://gis.unioncountync.gov/server/rest/services/Zoning_Map_MIL1/MapServer | 6 | ZONE | - | ✓ |
| Cumberland | https://gis.co.cumberland.nc.us/server/rest/services/Planning/CCZoning/MapServer | 1 | Zone_Class | - | ✓ |
| Orange | https://gis.orangecountync.gov/arcgis/rest/services/WebZoningService/MapServer | 22 | Zoning | Zoning_Def | ✓ |
| New Hanover | https://gis.nhcgov.com/server/rest/services/Layers/Zoning/MapServer | 1 | ZONING | - | ✓ |
| Guilford | https://gcgis.guilfordcountync.gov/arcgis/rest/services/Planning_Zoning/Combined_Zoning/MapServer | 0 | ZONING | DESCRIPTION | ✓ |
| Forsyth | https://maps.co.forsyth.nc.us/arcgis/rest/services/Planning_Inspection/Planning_Inspection/MapServer | 1 | ZONING_DISTRICT | - | ✓ |
| Randolph | — only LandUseCases, no zoning polygons | | | | ✗ none |
| Buncombe | — landuse svc has no clean zoning layer | | | | ✗ none |
| Gaston | https://gis.gastoncountync.gov/publicgis/rest/services/PublicGIS/Zoning/MapServer | 2 | ZONING | FULLPATH | ✓ all munis |
| Cabarrus | https://location.cabarruscounty.us/arcgisservices/rest/services/Zoning/MapServer | 7 | (joined) | (joined) | ✓ overlay only |
| Brunswick | https://bcgis.brunswickcountync.gov/arcgis/rest/services/Layers/Zoning/MapServer | 0 | ? | ? | ✓ |
| Iredell | https://maps.iredellcountync.gov/server/rest/services/Data/Zoning/MapServer | 0 | ZONING | - | ✓ |
| Rowan | https://gis.rowancountync.gov/arcgis/rest/services/Public/Alll_Zoning/MapServer | 0 | ZONING | TYPE | ✓ |
| Anson | https://ansoncountygis.com/arcgis/rest/services/ZoningLayers/MapServer | 5 | ZONECODE | - | ✓ |
| Lincoln | https://arcgisserver.lincolncountync.gov/arcgis/rest/services/LandReport/MapServer | 0 | ZONECLASS | ZONEDESC | ✓ restrict show:0 (mixed report map) |
| Onslow | https://gismaps.onslowcountync.gov/arcgis/rest/services/WEB_PUBLICATIONS/Planning_Data/MapServer | 0 | ZONECODE | - | ✓ restrict show:0 |
| Davidson | ArcMap_IMS_Test L27 not publicly accessible | | | | ✗ fallback |
| Henderson / Catawba / Alamance / Johnston / Pitt | only hosted FeatureServer or land-use, no export MapServer | | | | ✗ fallback |

## Export confirmed: Wake `/export` returns image/png HTTP 200.
## Overlay needs MapServer/ImageServer (export). Hosted FeatureServers can't render this way.
## Mixed report maps (Lincoln) need &layers=show:<id> restriction.
