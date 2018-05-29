#!/usr/bin/env bash
#
# This script assumes a linux environment

echo "*** uBlock0.edge: Creating web store package"
echo "*** uBlock0.edge: Copying files"

DES=dist/build/uBlock0.edge
rm -rf $DES
mkdir -p $DES

bash ./tools/make-assets.sh $DES

cp -R src/css               $DES/
cp -R src/img               $DES/
cp -R src/js                $DES/
cp -R src/lib               $DES/
cp -R src/_locales          $DES/
cp src/*.html               $DES/
cp platform/edge/*.js   $DES/js/
cp platform/edge/*.html $DES/
cp platform/edge/*.json $DES/
cp -R platform/edge/*.css $DES/css
cp LICENSE.txt              $DES/

echo "*** uBlock0.edge: concatenating content scripts"
cat $DES/js/vapi-usercss.js > /tmp/contentscript.js
echo >> /tmp/contentscript.js
grep -v "^'use strict';$" $DES/js/vapi-usercss.real.js >> /tmp/contentscript.js
echo >> /tmp/contentscript.js
grep -v "^'use strict';$" $DES/js/contentscript.js >> /tmp/contentscript.js
mv /tmp/contentscript.js $DES/js/contentscript.js
rm $DES/js/vapi-usercss.js
rm $DES/js/vapi-usercss.real.js

sed -i "s/'fullwide',\s*//g" $DES/js/*.js

cp -R $DES/_locales/nb $DES/_locales/no

echo "*** uBlock0.edge: Generating web accessible resources..."
cp -R src/web_accessible_resources $DES/
python3 tools/import-war.py $DES/

echo "*** uBlock0.edge: Generating meta..."
python tools/make-edge-meta.py $DES/

if [ "$1" = all ]; then
    echo "*** uBlock0.edge: Creating package..."
    pushd $(dirname $DES/) > /dev/null
    zip uBlock0.edge.zip -qr $(basename $DES/)/*
    popd > /dev/null
fi

echo "*** uBlock0.edge: Package done."
