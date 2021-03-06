Long Trail Planner
==================

This project provides the ability to produce various statistics related to a NOBO thru-hike of the Long Trail.

Parameters
----------

#### in model:
* HORZ_MPH (horizontal miles per hour)
* VERT_FPH (vertical feet per hour)
* REST_PERCENTAGE (as compared to moving time)

#### not in model:
* PACK_BASE_WEIGHT (in pounds)
* PACK_FOOD_WEIGHT (in pounds)
* BODY_WEIGHT (in pounds)

Inputs
------
* waypoint list 
    * provides landmarks with known distances
* trackpoint list 
    * provides the basis for micro distance and elevation measurements
    
Build & Run
------
Initialize and build the project with `npm install` from the root of the project

Start the server with `npm run start` from the root of the project

Open your browser to `http://localhost:3000` to view the output from the api


References
----------
* Long Trail Guide (https://store.greenmountainclub.org/products/long-trail-guide-28th-edition)
* OpenStreetMap Long Trail Relation (https://www.openstreetmap.org/relation/391736#map=9/43.5655/-72.8860)
* Waymarked Trails for OSM gpx download (https://hiking.waymarkedtrails.org/#?map=13!44.1423!-72.9045)
* GPS Visualizer for adding elevation data to gpx file (http://www.gpsvisualizer.com/)
* Gaia GPS for establishing waypoint locations

